const Web3 = require("web3");
const helpers = require('./helpers');
const fs = require('fs');
const ethers = require('ethers');
const log = require('simple-node-logger').createSimpleFileLogger('debug.log');

config = helpers.readConfig();

// http://stackoverflow.com/questions/951021/what-is-the-javascript-version-of-sleep
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

class Intermediary {

    constructor(accountId) {
        this.accountId = accountId;
        this.blockchains = {};
        this.loaded = false;
        this.stopLoop = false;
        this.fraud = 0;
    }

    setFraud(fraud = 0) {
        this.fraud = fraud;
        if (fraud === 0) {
            log.info('Fraud deactivated');
        }
        if (fraud === 1) {
            log.info('Fraud no exec activated, all others deactivated');
        }
        if (fraud === 2) {
            log.info('Fraud incorrect result activated, all others deactivated');
        }
        if (fraud === 3) {
            log.info('Fraud invalid gas cost activated, all others deactivated');
        }
    }

    async loadData() {
        // Start connections
        for (let blockchain of config.blockchains) {
            let web3 = new Web3(new Web3.providers.WebsocketProvider(blockchain.host));
            let distributionAbi = helpers.loadAbiFile(blockchain.distribution_contract_name);
            let distributionContract = web3.eth.Contract(distributionAbi, blockchain.distribution_contract_address);
            let invocationAbi = helpers.loadAbiFile(blockchain.invocation_contract_name);
            let invocationContract = web3.eth.Contract(invocationAbi, blockchain.invocation_contract_address);

            this.blockchains[blockchain.name] = {
                "name": blockchain.name,
                "web3": web3,
                "distributionContract": distributionContract,
                "distributionEvents": helpers.extractEvents(web3, distributionAbi),
                "invocationContract": invocationContract,
                "invocationEvents": helpers.extractEvents(web3, invocationAbi),
                "account": blockchain.accounts[this.accountId],
                "blockNumber": 0,
                "results": [],
                "invResults": [],
                "waitOffers": [],
                "myOffers": {},
            }
        }

        if (fs.existsSync("intermediary_" + this.accountId + ".json")) {
            let savedData = JSON.parse(fs.readFileSync("intermediary_" + this.accountId + ".json"));
            for (let savedEntry of savedData) {
                if (this.blockchains[savedEntry.blockchain] !== undefined) {
                    // Use ethers since there are bugs in conversion in web3 (see discussion at: https://github.com/ethereum/web3.js/issues/1920)
                    this.blockchains[savedEntry.blockchain].results = savedEntry.results.map((x) => ethers.utils.bigNumberify(x._hex));
                    this.blockchains[savedEntry.blockchain].invResults = savedEntry.invResults.map((x) => [ethers.utils.bigNumberify(x[0]._hex), x[1]]);
                    this.blockchains[savedEntry.blockchain].waitOffers = savedEntry.waitOffers.map((x) => ethers.utils.bigNumberify(x._hex));
                    savedEntry.myOffers.forEach((invocationId) => this.refetchOffer(savedEntry.blockchain, invocationId));
                }
            }
        }
        this.loaded = true;
    }


    async refetchOffer(blockchainId, invocationId) {
        let blockchain = this.blockchains[blockchainId];

        let offer = await blockchain.distributionContract.methods.getOffer(invocationId).call();
        let calling = await blockchain.distributionContract.methods.getCallInfo(invocationId).call();

        if (offer.offerer === blockchain.account) {
            offer.invocationId = invocationId;
            offer.calling = calling;
            blockchain.myOffers[invocationId] = offer;
            console.log("Reloaded offer: " + invocationId);
        }
    }

    writeData() {
        let data = [];

        for (const blockchainId in this.blockchains) {
            let blockchain = this.blockchains[blockchainId];

            let myOfferTmp = [];
            for (const invocationId in blockchain.myOffers) {
                myOfferTmp.push(invocationId);
            }

            data.push({
                "blockchain": blockchainId,
                "results": blockchain.results,
                "invResults": blockchain.invResults,
                "waitOffers": blockchain.waitOffers,
                "myOffers": myOfferTmp,
            });
        }

        fs.writeFileSync("intermediary_" + this.accountId + ".json", JSON.stringify(data, null, 2));

        console.log("Data saved", data);
    }

    // Listen for events
    async registerEventHandler() {
        for (const blockchainId in this.blockchains) {
            const blockchain = this.blockchains[blockchainId];

            blockchain.blockNumber = await blockchain.web3.eth.getBlockNumber();

            const that = this;

            blockchain.distributionContract.events.allEvents(
                {
                    fromBlock: blockchain.blockNumber
                }
            ).on('data', function (event) {
                console.log("Rec Dist intermed", event.event);
                if (event.event === 'NewCallRequest') {
                    blockchain.waitOffers.push(event.returnValues.invocationId);
                } else if (event.event === 'NewBestOffer') {
                    that.handleNewOffer(blockchainId, event.returnValues.invocationId);
                } else if (event.event === 'ResultAvailable') {
                    if (event.returnValues.sender === blockchain.account) {
                        blockchain.results.push(event.returnValues.invocationId);
                    }
                }
            }).on('error', console.error);

            blockchain.invocationContract.events.allEvents({
                fromBlock: blockchain.blockNumber
            }).on('data', function (event) {
                console.log("Rec Inter intermed", event.event);
                if (event.event === 'NewExecuteResult') {
                    if (event.returnValues.sender === blockchain.account) {
                        blockchain.invResults.push([event.returnValues.resultId, false]);
                    }
                } else if (event.event === 'NewExecuteUpdate') {
                    if (event.returnValues.sender === blockchain.account) {
                        blockchain.invResults.push([event.returnValues.resultId, true]);
                    }
                }
            }).on('error', console.error);
        }
    }

    async handleNewOffer(blockchainId, invocationId) {
        let blockchain = this.blockchains[blockchainId];
        let offer = await blockchain.distributionContract.methods.getOffer(invocationId).call();

        if (offer.offerer === blockchain.account) {
            let calling = await blockchain.distributionContract.methods.getCallInfo(invocationId).call();
            offer.invocationId = invocationId;
            offer.calling = calling;
            blockchain.myOffers[invocationId] = offer;
            console.log("Won first place for offer " + invocationId);
            log.info("First place offer: ", blockchain.account, " invocationId ", invocationId.toString(10));
        } else {
            if (blockchain.myOffers[invocationId] !== undefined) {
                delete blockchain.myOffers[invocationId];
                console.log("Lost first place for offer " + invocationId);
                log.info("Lost first place: ", blockchain.account, " invocationId ", invocationId.toString(10));
            }
            this.makeOffer(blockchainId, invocationId);
        }
    }

    /**
     * This function checks all blockchains for waiting offers and calls after state changes to offerphase
     */
    async handleWaitOffers() {
        for (const blockchainId in this.blockchains) {
            const blockchain = this.blockchains[blockchainId];

            let now = [];
            let past = [];

            for (const pos in blockchain.waitOffers) {
                let currentState = await blockchain.distributionContract.methods.getPhase(blockchain.waitOffers[pos]).call();
                if (currentState > config.phases.offer) {
                    past.push(pos);
                } else if (currentState === config.phases.offer) {
                    now.push(pos);
                }
            }

            past.forEach((pos) => {
                delete blockchain.waitOffers[pos];
            });

            now.forEach((pos) => {
                this.makeOffer(blockchainId, blockchain.waitOffers[pos]);
                delete blockchain.waitOffers[pos];
            });

            blockchain.waitOffers = blockchain.waitOffers.filter(function (el) {
                return el != null;
            });
        }
    }

    /*
     * This function makes an offer, if possible
     */
    async makeOffer(blockchainId, invocationId) {
        let blockchain = this.blockchains[blockchainId];

        let status = await blockchain.distributionContract.methods.getPhase(invocationId).call();

        // This offer is not in a valid phase anymore
        if (status > config.phases.offer) {
            return;
        }

        let calling = await blockchain.distributionContract.methods.getCallInfo(invocationId).call();
        let offer = await blockchain.distributionContract.methods.getOffer(invocationId).call();

        // Current best offer is made by itself
        if (offer.offerer === blockchain.account) {
            return;
        }

        let gasPrice = calling.maxGasPrice;


        if (offer.offerer !== '0x0000000000000000000000000000000000000000') {
            gasPrice = offer.gasPrice;
        }

        gasPrice = (gasPrice * (Math.random() * 0.3 + 0.7)) | 0;

        // Assume for demo purpose 2 as a good gas price per step for a transaction
        if (gasPrice < 2) {
            return;
        }

        blockchain.distributionContract.methods.makeOffer(invocationId, gasPrice).send({
            from: blockchain.account,
            gas: 200000,
        }).on('error', console.error).on('transactionHash', async (transactionHash) => {
            let transaction = null;
            while (transaction == null) {
                transaction = await blockchain.web3.eth.getTransactionReceipt(transactionHash);
                sleep(5000);
            }
            log.info("SubmitOffer ", invocationId.toString(10), ": ", transaction.gasUsed, ", ", transaction.cumulativeGasUsed);
        });
        console.log("Offer submitted");
        log.info("Submitted offer: ", blockchain.account, " invocationId ", invocationId.toString(10), " gas price ", gasPrice)
    }

    /**
     * Checks all offers, if already in a winning state, if so start request at target chain
     */
    async checkWinningOffers() {
        for (const blockchainId in this.blockchains) {
            const blockchain = this.blockchains[blockchainId];

            let winners = [];
            let loosers = [];

            for (const invocationId in blockchain.myOffers) {
                let offer = blockchain.myOffers[invocationId];

                let currentState = await blockchain.distributionContract.methods.getPhase(invocationId).call();
                let currentOffer = await blockchain.distributionContract.methods.getOffer(invocationId).call();

                if (currentOffer.offerer !== blockchain.account) {
                    loosers.push(invocationId);
                } else if (currentOffer.gasPrice.toString(10) !== offer.gasPrice.toString(10)) {
                    loosers.push(invocationId);
                } else if (currentState > config.phases.pretransaction) {
                    winners.push(invocationId);
                }
            }

            loosers.forEach((invocationId) => {
                delete blockchain.myOffers[invocationId];
            });
            winners.forEach((invocationId) => {
                if (this.makeTargetRequest(blockchainId, blockchain.myOffers[invocationId])) {
                    delete blockchain.myOffers[invocationId];
                }
            });
        }
    }

    makeTargetRequest(blockchainId, offer) {
        let sourceBlockChain = this.blockchains[blockchainId];
        let targetChainId = sourceBlockChain.web3.utils.toUtf8(offer.calling.blockchainId);

        let targetBlockchain = this.blockchains[targetChainId];

        if (targetBlockchain === undefined) {
            return false;
        }

        if (offer.calling.parameters == null) {
            offer.calling.parameters = "0x";
        }

        if (this.fraud === 1) {
            log.info("Skipping target chain request, fraud active");
            return true;
        }
        targetBlockchain.invocationContract.methods.executeCall(targetBlockchain.web3.utils.fromUtf8(blockchainId), offer.calling.contractId, offer.invocationId, offer.calling.maxSteps, offer.calling.parameters).send({
            from: targetBlockchain.account,
            //gasPrice: offer.gasPrice,
            gas: 500000,
        }).on('transactionHash', async (transactionHash) => {
            let transaction = null;
            while (transaction == null) {
                transaction = await targetBlockchain.web3.eth.getTransactionReceipt(transactionHash);
                sleep(5000);
            }
            log.info("TargetBlockchain Submit ", offer.invocationId.toString(10), ": ", transaction.gasUsed, ", ", transaction.cumulativeGasUsed);
        }).on('error', console.error);

        console.log("External call triggered");
        return true;
    }

    async handleAllInvResults() {
        for (const blockchainId in this.blockchains) {
            const blockchain = this.blockchains[blockchainId];

            let now = [];

            for (const pos in blockchain.invResults) {
                let currentState = await blockchain.invocationContract.methods.getResultPhase(blockchain.invResults[pos][0]).call();
                if (currentState === config.resultphases.verified) {
                    now.push(pos);
                }
            }

            now.forEach((pos) => {
                this.handleResult(blockchainId, blockchain.invResults[pos][0], blockchain.invResults[pos][1]);
                delete blockchain.invResults[pos];
            });

            blockchain.invResults = blockchain.invResults.filter(function (el) {
                return el != null;
            });
        }
    }

    async getBalance(blockchainId) {
        let balance = await this.blockchains[blockchainId].web3.eth.getBalance(this.blockchains[blockchainId].account);
        log.info("New token balance for intermediary ", this.blockchains[blockchainId].account, " is ", balance);
        return balance;
    }

    async handleResult(blockchainId, resultId, update = false) {
        let targetBlockChain = this.blockchains[blockchainId];
        let result = await targetBlockChain.invocationContract.methods.getResultInfo(resultId).call();

        if (result.resultData == null) {
            result.resultData = "0x";
        }

        if (this.fraud === 2) {
            log.info("Manipulating result");
            result.resultData = "0xff00ff00ff00ff00";
        }
        if (this.fraud === 3) {
            log.info("Manipulating gas");
            result.requiredSteps = result.requiredSteps.mul(2);
        }

        let sourceBlockchain = this.blockchains[targetBlockChain.web3.utils.toUtf8(result.sourceId)];

        let phase = await sourceBlockchain.distributionContract.methods.getPhase(result.invocationId).call();

        if (phase === config.phases.transaction) {
            if (result.status === 2) {
                if (!update) {
                    sourceBlockchain.distributionContract.methods.registerResult(result.invocationId, resultId).send({
                        from: sourceBlockchain.account,
                        gas: 500000,
                    }).on('error', console.error).on('transactionHash', async (transactionHash) => {
                        let transaction = null;
                        while (transaction == null) {
                            transaction = await sourceBlockchain.web3.eth.getTransactionReceipt(transactionHash);
                            sleep(5000);
                        }
                        log.info("Register result ", result.invocationId.toString(10), ": ", transaction.gasUsed, ", ", transaction.cumulativeGasUsed);
                    });
                    console.log("Result registered");
                } else {
                    console.log("Result updated", result);
                }
            } else {
                sourceBlockchain.distributionContract.methods.submitResult(result.invocationId, resultId, result.status, result.resultData, result.requiredSteps).send({
                    from: sourceBlockchain.account,
                    gas: 1000000,
                }).on('error', console.error).on('transactionHash', async (transactionHash) => {
                    let transaction = null;
                    while (transaction == null) {
                        transaction = await sourceBlockchain.web3.eth.getTransactionReceipt(transactionHash);
                        sleep(5000);
                    }
                    log.info("Submit result ", result.invocationId.toString(10), ": ", transaction.gasUsed, ", ", transaction.cumulativeGasUsed);
                });
                console.log("Result submitted");
            }
        }
    }

    async claimMoney() {
        for (const blockchainId in this.blockchains) {
            const blockchain = this.blockchains[blockchainId];

            while (blockchain.results.length > 0) {
                let invocationId = blockchain.results.shift();
                let phase = await blockchain.distributionContract.methods.getPhase(invocationId).call();

                if (phase < config.phases.waitforfinish) {
                    blockchain.results.unshift(invocationId);
                    return;
                }
                if (phase > config.phases.waitforfinish) {
                    continue;
                }

                blockchain.distributionContract.methods.finalize(invocationId).send({
                    from: blockchain.account,
                    gas: 1000000,
                }).on('error', console.error).on('transactionHash', async (transactionHash) => {
                    let transaction = null;
                    while (transaction == null) {
                        transaction = await blockchain.web3.eth.getTransactionReceipt(transactionHash);
                        sleep(5000);
                    }
                    log.info("Finalize ", invocationId.toString(10), ": ", transaction.gasUsed, ", ", transaction.cumulativeGasUsed);
                });
                console.log("Money claimed");
            }
        }
    }

    async looping() {
        for (const blockchainId in this.blockchains) {
            let blockchain = this.blockchains[blockchainId];
            blockchain.blockNumber = await blockchain.web3.eth.getBlockNumber();
        }
        await this.handleWaitOffers();
        await this.checkWinningOffers();
        await this.handleAllInvResults();
        await this.claimMoney();

        if (!this.stopLoop) {
            setTimeout(this.looping.bind(this), 1000);
        }
    }

    async start() {
        log.info("Intermediary started");
        if (!this.loaded) {
            await this.loadData();
            await this.registerEventHandler();
        }
        this.stopLoop = false;
        setTimeout(this.looping.bind(this), 1000);
    }

    stop() {
        this.stopLoop = true;
        if (this.loaded) {
            this.writeData();
        }
        log.info("Intermediary stopped");
    }
}

if (require.main === module) {
    console.log("Called directly");
    let accountId = process.argv[2];
    if (accountId == undefined) {
        accountId = 1;
    }
    accountId = parseInt(accountId);
    var intermediary = new Intermediary(accountId);
    intermediary.start();

    process.on('SIGINT', function () {
        intermediary.stop();
        process.exit();
    });
} else {
    module.exports = Intermediary;
}



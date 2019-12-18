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

class Validator {

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
            log.info('Behaving honest');
        }
        if (fraud === 1) {
            log.info('Behaving dishonest');
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
                "votingQueue": [],
                "fraudDetection": [],
                "fraudWinnings": [],
            }
        }

        if (fs.existsSync("validator_" + this.accountId + ".json")) {
            let savedData = JSON.parse(fs.readFileSync("validator_" + this.accountId + ".json"));
            for (let savedEntry of savedData) {
                if (this.blockchains[savedEntry.blockchain] !== undefined) {
                    // Use ethers since there are bugs in conversion in web3 (see discussion at: https://github.com/ethereum/web3.js/issues/1920)
                    this.blockchains[savedEntry.blockchain].votingQueue = savedEntry.votingQueue.map((x) => ethers.utils.bigNumberify(x._hex));
                    this.blockchains[savedEntry.blockchain].fraudDetection = savedEntry.fraudDetection.map((x) => ethers.utils.bigNumberify(x._hex));
                    this.blockchains[savedEntry.blockchain].fraudWinnings = savedEntry.fraudWinnings.map((x) => ethers.utils.bigNumberify(x._hex));
                }
            }
        }

        this.loaded = true;
    }

    async registerEventHandler() {
        for (const blockchainId in this.blockchains) {
            const blockchain = this.blockchains[blockchainId];
            blockchain.blockNumber = await blockchain.web3.eth.getBlockNumber();

            blockchain.distributionContract.events.allEvents(
                {
                    fromBlock: blockchain.blockNumber
                }
            ).on('data', function (event) {
                console.log("Rec Dist vali", event.event);
                if (event.event === 'ResultAvailable') {
                    blockchain.votingQueue.push(event.returnValues.invocationId);
                }
                if (event.event === 'NewCallRequest') {
                    blockchain.fraudDetection.push(event.returnValues.invocationId);
                }
                if (event.event === 'NewFraudVotingWinner') {
                    blockchain.fraudWinnings = blockchain.fraudWinnings
                        .filter((x) => (x.toString(10) !== event.returnValues.invocationId.toString(10)));
                    if (event.returnValues.winner === blockchain.account) {
                        blockchain.fraudWinnings.push(event.returnValues.invocationId);
                        console.log("Winning fraud voting", event.returnValues.invocationId);
                    } else {
                        console.log("Loosing fraud voting", event.returnValues.invocationId);
                    }
                }
            }).on('error', console.error);
        }
    }

    async checkFraudDetectionStatus() {
        for (const blockchainId in this.blockchains) {
            const blockchain = this.blockchains[blockchainId];
            let now = [];
            let past = [];

            for (const pos in blockchain.fraudDetection) {
                const invocationId = blockchain.fraudDetection[pos];

                // Check transaction phase, for example if no offer has been made
                let phase = await blockchain.distributionContract.methods.getPhase(invocationId).call();
                if (phase > config.phases.postvote) {
                    past.push(pos);
                    continue;
                }

                let fraudPhase = await blockchain.distributionContract.methods.getFraudDetectionPhase(invocationId).call();

                if (fraudPhase === config.votingphases.voting) {
                    now.push(pos);
                } else if (fraudPhase > config.votingphases.voting) {
                    past.push(pos);
                }
            }

            past.forEach((pos) => {
                delete blockchain.fraudDetection[pos];
            });

            for (const pos of now) {
                if (await this.handleFraudVoting(blockchainId, blockchain.fraudDetection[pos])) {
                    delete blockchain.fraudDetection[pos];
                }
            }

            blockchain.fraudDetection = blockchain.fraudDetection.filter((x) => (x != null));
        }
    }

    async handleFraudVoting(blockchainId, invocationId) {
        const blockchain = this.blockchains[blockchainId];
        console.log("FraudVoting", blockchainId, invocationId, blockchain.fraudDetection);

        let resultInfo = await blockchain.distributionContract.methods.getResultInfo(invocationId).call();

        let voteStatus = 3;
        if (resultInfo.resultId !== 0) {
            let callingInfo = await blockchain.distributionContract.methods.getCallInfo(invocationId).call();
            let targetChainId = blockchain.web3.utils.toUtf8(callingInfo.blockchainId);
            let resultInfoTarget = await this.blockchains[targetChainId].invocationContract.methods.getResultInfo(resultInfo.resultId).call();

            // Status is waiting
            if (resultInfoTarget.status === 2) {
                voteStatus = 2;
            } else {
                let blockNumber = await this.blockchains[targetChainId].web3.eth.getBlockNumber();
                if (resultInfoTarget.startBlock + config.fraudDistanceBlocks >= blockNumber) {
                    voteStatus = 2;
                }
            }
        }

        let voted = true;

        if (voteStatus === 2) {
            let voteInfo = await blockchain.distributionContract.methods.getFraudVotingInfo(invocationId).call();
            if (voteInfo.totalVotes.toString(10) === "0") {
                voted = false;
            }
        }

        if (voted) {
            blockchain.distributionContract.methods.fraudVote(invocationId, voteStatus).send({
                from: blockchain.account,
                gas: 1000000,
            }).on('error', console.error).on('transactionHash', async (transactionHash) => {
                let transaction = null;
                while (transaction == null) {
                    transaction = await blockchain.web3.eth.getTransactionReceipt(transactionHash);
                    sleep(5000);
                }
                log.info("FraudVote ",invocationId.toString(10),": ", transaction.gasUsed, ", ", transaction.cumulativeGasUsed);
            });
            console.log("Voted FraudDetection");
        } else {
            console.log("skipped")
        }
        return voted;
    }

    async handleWinnings() {
        for (const blockchainId in this.blockchains) {
            const blockchain = this.blockchains[blockchainId];

            let winners = [];
            let loosers = [];

            for (const pos in blockchain.fraudWinnings) {
                const invocationId = blockchain.fraudWinnings[pos];
                let phase = await blockchain.distributionContract.methods.getFraudDetectionPhase(invocationId).call();
                if (phase < config.votingphases.waitforfinalize) {
                    // Do nothing
                } else if (phase === config.votingphases.waitforfinalize) {
                    let votingInfo = await blockchain.distributionContract.methods.getFraudVotingInfo(invocationId).call();
                    if (votingInfo.winner === blockchain.account) {
                        winners.push(pos);
                    } else {
                        loosers.push(pos);
                    }
                } else {
                    loosers.push(pos);
                }
            }

            loosers.forEach((pos) => {
                delete blockchain.fraudWinnings[pos];
            });

            for (const pos of winners) {
                let invocationId = blockchain.fraudWinnings[pos];
                blockchain.distributionContract.methods.finalizeFraudVoting(invocationId).send({
                    from: blockchain.account,
                    gas: 6721975,
                }).on('error', console.error).on('transactionHash', async (transactionHash) => {
                    let transaction = null;
                    while (transaction == null) {
                        transaction = await blockchain.web3.eth.getTransactionReceipt(transactionHash);
                        sleep(5000);
                    }
                    log.info("FinalizeFraudVote ",invocationId.toString(10) ,": ", transaction.gasUsed, ", ", transaction.cumulativeGasUsed);
                });
                console.log("Finalized FraudVoting");
                delete blockchain.fraudWinnings[pos];
            }

            blockchain.fraudWinnings = blockchain.fraudWinnings.filter((x) => (x != null));
        }
    }

    async processVoting() {
        for (const blockchainId in this.blockchains) {
            const blockchain = this.blockchains[blockchainId];

            const invocationId = blockchain.votingQueue.shift();
            if (invocationId === undefined) {
                continue;
            }

            let phase = await blockchain.distributionContract.methods.getPhase(invocationId).call();

            if (phase !== config.phases.vote) {
                blockchain.votingQueue.unshift(invocationId);
                continue;
            }

            let resultInfo = await blockchain.distributionContract.methods.getResultInfo(invocationId).call();
            let callingInfo = await blockchain.distributionContract.methods.getCallInfo(invocationId).call();
            let offerInfo = await blockchain.distributionContract.methods.getOffer(invocationId).call();
            let sourceInfo = this.generateSourceInfo(invocationId, callingInfo, offerInfo, resultInfo);

            let targetChainId = blockchain.web3.utils.toUtf8(callingInfo.blockchainId);
            let resultInfoTarget = await this.blockchains[targetChainId].invocationContract.methods.getResultInfo(resultInfo.resultId).call();
            let targetInfo = this.generateTargetInfo(resultInfoTarget);

            console.log(sourceInfo, targetInfo);

            let validCall = this.validateCall(sourceInfo, targetInfo);

            blockchain.distributionContract.methods.vote(invocationId, validCall).send({
                from: blockchain.account,
                gas: 200000,
            }).on('error', console.error).on('transactionHash', async (transactionHash) => {
                let transaction = null;
                while (transaction == null) {
                    transaction = await blockchain.web3.eth.getTransactionReceipt(transactionHash);
                    sleep(5000);
                }
                log.info("Vote ",invocationId.toString(10),": ", transaction.gasUsed, ", ", transaction.cumulativeGasUsed);
                await this.getBalance(blockchainId);
            });

            if (this.fraud === 1) {
                log.info("Dishonest voter, change result from ", validCall);
                if (validCall < 2) {
                    validCall = 2;
                } else {
                    validCall = 0;
                }
            }

            log.info("Voted ", blockchain.account, ", invocationId: ", invocationId.toString(10), ", value: " + validCall);

            console.log("voted", validCall);
        }
    }

    async getBalance(blockchainId) {
        let balance = await this.blockchains[blockchainId].web3.eth.getBalance(this.blockchains[blockchainId].account);
        log.info("New token balance for validator ", this.blockchains[blockchainId].account, " is ", balance);
        return balance;
    }

    generateSourceInfo(invocationId, callingInfo, offerInfo, resultInfo) {
        return {
            invocationId: invocationId.toString(10),
            parameters: callingInfo.parameters,
            resultStatus: resultInfo.status,
            result: resultInfo.resultData,
            contractId: callingInfo.contractId.toLowerCase(),
            maxSteps: callingInfo.maxSteps.toString(10),
            requiredSteps: resultInfo.requiredSteps.toString(10),
        };
    }

    generateTargetInfo(resultInfoTarget) {
        return {
            invocationId: resultInfoTarget.invocationId.toString(10),
            parameters: resultInfoTarget.parameters,
            resultStatus: resultInfoTarget.status,
            result: resultInfoTarget.resultData,
            contractId: resultInfoTarget.contractAddress.toLowerCase(),
            maxSteps: resultInfoTarget.maxSteps.toString(10),
            requiredSteps: resultInfoTarget.requiredSteps.toString(10),
        };
    }

    validateCall(source, target) {
        let level1 = ['invocationId', 'parameters', 'resultStatus', 'result', 'contractId', 'maxSteps'];
        let level2 = ['requiredSteps'];
        for (let el of level1) {
            if (source[el] === undefined) {
                source[el] = null;
            }
            if (target[el] === undefined) {
                target[el] = null;
            }
            if (source[el] !== target[el]) {
                return 0;
            }
        }
        for (let el of level2) {
            if (source[el] === undefined) {
                source[el] = null;
            }
            if (target[el] === undefined) {
                target[el] = null;
            }
            if (source[el] !== target[el]) {
                return 1;
            }
        }
        return 2;
    }

    writeData() {
        let data = [];

        for (const blockchainId in this.blockchains) {
            let blockchain = this.blockchains[blockchainId];

            data.push({
                "blockchain": blockchainId,
                "votingQueue": blockchain.votingQueue,
                "fraudDetection": blockchain.fraudDetection,
                "fraudWinnings": blockchain.fraudWinnings,
            });
        }

        fs.writeFileSync("validator_" + this.accountId + ".json", JSON.stringify(data, null, 2));

        console.log("Data saved", data);
    }

    async looping() {
        await this.processVoting();
        await this.checkFraudDetectionStatus();
        await this.handleWinnings();

        if (!this.stopLoop) {
            setTimeout(this.looping.bind(this), 1000);
        }
    }

    async start() {
        log.info("Validator started");
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
        log.info("Validator stopped");
    }
}

if (require.main === module) {
    console.log("Called directly");
    let accountId = process.argv[2];
    if (accountId == undefined) {
        accountId = 2;
    }
    accountId = parseInt(accountId);
    let validator = new Validator(accountId);
    validator.start();

    process.on('SIGINT', function () {
        validator.stop();
        process.exit();
    });
} else {
    module.exports = Validator;
}



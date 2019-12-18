const Web3 = require("web3");
const helpers = require('./helpers');

// All blockchain names have to use 4 characters
const blockchains = [
    {
        name: "ETH0",
        host: "ws://127.0.0.1:8546",
        distribution_contract_name: "__contracts_DistributionContract_sol_DistributionContract",
        distribution_contract_address: null,
        invocation_contract_name: "__contracts_InvocationContract_sol_InvocationContract",
        invocation_contract_address: null,
        test_contract_name: "__contracts_TestContract_sol_TestContract",
        test_contract_address: null,
        contracts: [
            "0x2882ecca4d3381637a49546055d43566c441770e",
            "0xc80c5194d614f4763c625b5f0ad434a2349e6d86",
            "0x1b16d3b818f566180e5aa22f5735fd28f64e9b75",
        ]
    }, {
        name: "ETH1",
        host: "ws://127.0.0.1:8546",
        distribution_contract_name: "__contracts_DistributionContract_sol_DistributionContract",
        distribution_contract_address: null,
        invocation_contract_name: "__contracts_InvocationContract_sol_InvocationContract",
        invocation_contract_address: null,
        test_contract_name: "__contracts_TestContract_sol_TestContract",
        test_contract_address: null,
        contracts: [
            "0x2afe60fa7ce683f434362a272e20ec03cd224166",
            "0x31f34e583bbff1741b32127196f48ee75e27bedf",
            "0xf53a240bca10ec8f8133d475297aa2c3857295dc"
        ]
    }//,
    /*{
        name: "ETH2",
        host: "http://localhost:8530",
        distribution_contract_name: "__contracts_DistributionContract_sol_DistributionContract",
        distribution_contract_address: null,
        invocation_contract_name: "__contracts_InvocationContract_sol_InvocationContract",
        invocation_contract_address: null,
        test_contract_name: "__contracts_TestContract_sol_TestContract",
        test_contract_address: null,
    }*/
];

// http://stackoverflow.com/questions/951021/what-is-the-javascript-version-of-sleep
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function deployContract(web3, name, account, privKey) {
    let abi = helpers.loadAbiFile(name);
    let bin = helpers.loadBinFile(name);
    let myContract = web3.eth.Contract(abi);

    let address = null;

    let contractData = myContract.deploy({data: '0x' + bin}).encodeABI();

    Contract.deploy().send({from: account, gas: 5000000}).on('receipt', (receipt) => {
        // Bug: receipt is fetched too late, thus use transaction Hash
    }).on('transactionHash', async (transactionHash) => {
        let transaction = null;
        while (transaction == null) {
            transaction = await web3.eth.getTransactionReceipt(transactionHash);
            sleep(1000);
        }
        address = transaction.contractAddress;
    }).on('error', console.error);

    console.log("Deploy called");

    while (address == null) {
        await sleep(1000);
    }

    console.log("Deployed: ", name);

    return address;
}

async function initChains() {
    testAddresses = [];

    for (let blockchain of blockchains) {
        console.log("Handling next blockchain");
        let web3 = new Web3(new Web3.providers.WebsocketProvider(blockchain.host));
        blockchain.accounts = await web3.eth.getAccounts();

        //Deployment does not work, deploy via geth following guide, gasLimit required to be 4,229,144
        //https://medium.com/mercuryprotocol/dev-highlights-of-this-week-cb33e58c745f
        /*
        let contracts = [
            await deployContract(web3, blockchain.distribution_contract_name, blockchain.accounts[0], blockchain.privateKeys[0]),
            await deployContract(web3, blockchain.invocation_contract_name, blockchain.accounts[0], blockchain.privateKeys[0]),
            await deployContract(web3, blockchain.test_contract_name, blockchain.accounts[0], blockchain.privateKeys[0]),
        ];*/

        let contracts = blockchain.contracts;

        blockchain.distribution_contract_address = contracts[0];
        blockchain.invocation_contract_address = await contracts[1];
        blockchain.test_contract_address = await contracts[2];
        testAddresses.push(blockchain.test_contract_address);

        let hash = null;
        let distributionAbi = helpers.loadAbiFile(blockchain.distribution_contract_name);
        let distributionContract = web3.eth.Contract(distributionAbi, blockchain.distribution_contract_address);
        distributionContract.methods.setInvocationContract(blockchain.invocation_contract_address).send({
            from: blockchain.accounts[0],
            gas: 5000000
        }).on('transactionHash', async (x) => {
            hash = x;
        }).on('error', console.error);

        while (hash == null) {
            await sleep(100);
        }

        console.log("Distribution set");

        hash = null;
        let invocationAbi = helpers.loadAbiFile(blockchain.invocation_contract_name);
        let invocationContract = web3.eth.Contract(invocationAbi, blockchain.invocation_contract_address);
        invocationContract.methods.setDistributionContract(blockchain.distribution_contract_address).send({
            from: blockchain.accounts[0],
            gas: 5000000
        }).on('transactionHash', async (x) => {
            hash = x;
        }).on('error', console.error);

        while (hash == null) {
            await sleep(100);
        }

        console.log("Invocation set");

        await loadTestContract(web3, blockchain);

        for (let i = 1; i < blockchain.accounts.length; i++) {
            await makeDeposit(web3, blockchain, i);
        }
        console.log("Funded set");
    }

    // Set addresses
    for (let blockchain of blockchains) {
        let web3 = new Web3(new Web3.providers.WebsocketProvider(blockchain.host));
        hash = null;
        let testAbi = helpers.loadAbiFile(blockchain.test_contract_name);
        let testContract = web3.eth.Contract(testAbi, blockchain.test_contract_address);
        testContract.methods.setAddresses(blockchain.distribution_contract_address, testAddresses[0 % testAddresses.length], testAddresses[1 % testAddresses.length], testAddresses[2 % testAddresses.length]).send({
            from: blockchain.accounts[0],
            gas: 5000000
        }).on('transactionHash', (x) => {
            hash = x;
        }).on('error', console.error);

        while (hash == null) {
            await sleep(100);
        }
    }
    console.log("Test set");
    config.blockchains = blockchains;
}

async function loadTestContract(web3, blockchain) {
    let hash = null;
    web3.eth.sendTransaction({
        from: blockchain.accounts[0],
        to: blockchain.test_contract_address,
        value: 100000000000000,
    }).on('transactionHash', async (x) => {
        hash = x;
    }).on('error', console.error);

    while (hash == null) {
        await sleep(100);
    }

    return true;
}

async function makeDeposit(web3, blockchain, accId) {
    let hash = null;
    let distributionAbi = helpers.loadAbiFile(blockchain.distribution_contract_name);
    let distributionContract = web3.eth.Contract(distributionAbi, blockchain.distribution_contract_address);
    distributionContract.methods.depositCoins().send({
        from: blockchain.accounts[accId],
        gas: 5000000,
        value: 5000000000000000,
    }).on('transactionHash', async (x) => {
        hash = x;
    }).on('error', console.error);

    while (hash == null) {
        await sleep(1000);
    }

    return true;
}

async function mine() {
    let blockchain = config.blockchains[0];
    let web3 = new Web3(new Web3.providers.WebsocketProvider(blockchain.host));
    let testAbi = helpers.loadAbiFile(blockchain.test_contract_name);
    let testContract = web3.eth.Contract(testAbi, blockchain.test_contract_address);

    let hash = null;

    testContract.methods.postResult(0).send({from: blockchain.accounts[0]}).on('transactionHash', (x) => {
        hash = x;
    }).on('error', console.error);

    while (hash == null) {
        await sleep(100);
    }

    // Check receipt, otherwise the block has not been mined
    transaction = null;
    while (transaction == null) {
        transaction = await web3.eth.getTransactionReceipt(hash);
        await sleep(1000);
    }
}

async function load() {
    config = helpers.readConfig();
    if (process.argv[2] == 'deploy') {
        await initChains();
        helpers.writeConfig(config);
    }
    if (process.argv[2] == 'mine') {
        for (let i = 0; i < parseInt(process.argv[3]); i++) {
            await mine();
        }
    }
    if (process.argv[2] == 'accountinfo') {
        for (let blockchain of config.blockchains) {
            let web3 = new Web3(new Web3.providers.WebsocketProvider(blockchain.host));
            for (const accountId in blockchain.accounts) {
                if (accountId < 4) {
                    console.log("Account " + accountId + ": " + blockchain.accounts[accountId]);
                    console.log(await web3.eth.getBalance(blockchain.accounts[accountId]));
                }
            }
            console.log("Contract DistributionContract");
            console.log(await web3.eth.getBalance(blockchain.distribution_contract_address));
            console.log("Contract InvocationContract");
            console.log(await web3.eth.getBalance(blockchain.invocation_contract_address));
            console.log("Contract Test");
            console.log(await web3.eth.getBalance(blockchain.test_contract_address));
        }
    }
    if (process.argv[2] == 'lastresult') {
        for (let blockchain of config.blockchains) {
            let web3 = new Web3(new Web3.providers.WebsocketProvider(blockchain.host));
            let testAbi = helpers.loadAbiFile(blockchain.test_contract_name);
            let testContract = web3.eth.Contract(testAbi, blockchain.test_contract_address);
            /*testContract.methods.postResult(10).send({
                from: blockchain.accounts[0],
            });*/
            console.log("Last result: ", await testContract.methods.getLastResult().call());
        }
    }

    if (process.argv[2] == 'callinfo') {
        let blockchain = config.blockchains[0];
        let web3 = new Web3(new Web3.providers.WebsocketProvider(blockchain.host));
        let distributionAbi = helpers.loadAbiFile(blockchain.distribution_contract_name);
        let distributionContract = web3.eth.Contract(distributionAbi, blockchain.distribution_contract_address);
        console.log("Last result: ",
            await distributionContract.methods.getCallInfo(process.argv[3]).call(),
            await distributionContract.methods.getResultInfo(process.argv[3]).call(),
            "PHASE: " + await distributionContract.methods.getPhase(process.argv[3]).call());
    }

    if (process.argv[2] == 'block') {
        let blockchain = config.blockchains[0];
        let web3 = new Web3(new Web3.providers.WebsocketProvider(blockchain.host));
        console.log("Block: ", await web3.eth.getBlock(process.argv[3]));
    }

    if (process.argv[2] == 'transaction') {
        let blockchain = config.blockchains[0];
        let web3 = new Web3(new Web3.providers.WebsocketProvider(blockchain.host));
        console.log("Block: ", await web3.eth.getTransactionReceipt(process.argv[3]));
    }

    if (process.argv[2] == 'loadContract') {
        let blockchain = config.blockchains[0];
        let web3 = new Web3(new Web3.providers.WebsocketProvider(blockchain.host));
        await loadTestContract(web3, blockchain);
    }

    if (process.argv[2] == 'makeDeposit') {
        let blockchain = config.blockchains[0];
        let web3 = new Web3(new Web3.providers.WebsocketProvider(blockchain.host));
        for (let i = 1; i < blockchain.accounts.length; i++) {
            await makeDeposit(web3, blockchain, i);
        }
    }

    process.exit()
}

setTimeout(load, 0);

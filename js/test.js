const log = require('simple-node-logger').createSimpleFileLogger('debug.log');
const Intermediary = require('./intermediary');
const Validator = require('./validator');
const Web3 = require("web3");
const helpers = require('./helpers');

let intermediary1 = new Intermediary(1);
let intermediary2 = new Intermediary(5);
let intermediary3 = new Intermediary(3);
let validator1 = new Validator(2);
let validator2 = new Validator(6);
let validator3 = new Validator(7);

let blockchains = {};


// http://stackoverflow.com/questions/951021/what-is-the-javascript-version-of-sleep
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

for (let blockchain of config.blockchains) {
    let web3 = new Web3(new Web3.providers.WebsocketProvider(blockchain.host));
    let distributionAbi = helpers.loadAbiFile(blockchain.distribution_contract_name);
    let distributionContract = web3.eth.Contract(distributionAbi, blockchain.distribution_contract_address);
    let invocationAbi = helpers.loadAbiFile(blockchain.invocation_contract_name);
    let invocationContract = web3.eth.Contract(invocationAbi, blockchain.invocation_contract_address);
    let testAbi = helpers.loadAbiFile(blockchain.test_contract_name);
    let testContract = web3.eth.Contract(testAbi, blockchain.test_contract_address);

    blockchains[blockchain.name] = {
        "name": blockchain.name,
        "web3": web3,
        "distributionContract": distributionContract,
        "invocationContract": invocationContract,
        "testContract": testContract,
        "test_contract_address": blockchain.test_contract_address,
        "testAbi": testAbi,
        "account": blockchain.accounts[0],
        "testAccount": blockchain.accounts[0],
        "registered": [],
        "finished": [],
    };

    blockchains[blockchain.name].distributionContract.events.allEvents(
        {
            fromBlock: blockchain.blockNumber
        }
    ).on('data', function (event) {
        log.info("New event '", event.event, "' on contract distributionContract on blockchain ", blockchain.name, " blockNumber: ", event.blockNumber, " data: ", event.returnValues);
        if (event.event === 'NewCallRequest') {
            blockchains[blockchain.name].registered.push(event.returnValues.invocationId);
        } else if (event.event === 'CallFinished') {
            blockchains[blockchain.name].finished.push(event.returnValues.invocationId);
        }
    }).on('error', console.error);

    blockchains[blockchain.name].invocationContract.events.allEvents(
        {
            fromBlock: blockchain.blockNumber
        }
    ).on('data', function (event) {
        log.info("New event '", event.event, "' on contract invocationContract on blockchain ", blockchain.name, " blockNumber: ", event.blockNumber, " data: ", event.returnValues);
    }).on('error', console.error);
}

async function reset(blockchainId, type, value) {
    let transactionHash = null;
    if (type === 'bool') {
        blockchains[blockchainId].testContract.methods.setBool(value).send({
            from: blockchains[blockchainId].account,
            gas: 5000000
        }).on('transactionHash', (x) => {
            transactionHash = x;
        }).on('error', console.error);
    } else if (type === 'text') {
        blockchains[blockchainId].testContract.methods.setText(value).send({
            from: blockchains[blockchainId].account,
            gas: 5000000
        }).on('transactionHash', (x) => {
            transactionHash = x;
        }).on('error', console.error);
    }

    while (transactionHash == null) {
        await sleep(100);
    }

    let transaction = null;
    while (transaction == null) {
        transaction = await blockchains[blockchainId].web3.eth.getTransactionReceipt(transactionHash);
        sleep(1000);
    }

    return await getValue(blockchainId, type);
}

async function getValue(blockchainId, type) {
    let returnValue = null;

    if (type === 'bool') {
        returnValue = await blockchains[blockchainId].testContract.methods.getBool().call();
    } else if (type === 'text') {
        returnValue = await blockchains[blockchainId].testContract.methods.getText().call();
    } else {
        returnValue = null;
    }

    log.info("Current " + type + " value on blockchain " + blockchains[blockchainId].name + ": '" + returnValue + "'");

    return returnValue;
}

async function registerCall(fromBlockchainId, toBlockchainId, params = [], callback = null) {
    let fromBlockchain = blockchains[fromBlockchainId];
    let toBlockchain = blockchains[toBlockchainId];
    let functionName = params.shift();
    let encodedParams = toBlockchain.web3.eth.abi.encodeFunctionCall(toBlockchain.testAbi.find((x) => x.name === functionName), params);

    let callbackGas = 0;
    let callbackAddress = "0x" + fromBlockchain.web3.utils.padRight("", 40, "0");
    let callbackMethodSelector = "0x" + fromBlockchain.web3.utils.padRight("", 8, "0");

    if (callback !== null) {
        callbackGas = 1000000;
        callbackAddress = fromBlockchain.test_contract_address;
        callbackMethodSelector = fromBlockchain.web3.eth.abi.encodeFunctionSignature(fromBlockchain.testAbi.find((x) => x.name === callback));
    }

    let hash = null;

    fromBlockchain.distributionContract.methods.registerCall(
        toBlockchain.web3.utils.utf8ToHex(toBlockchain.name),
        toBlockchain.test_contract_address,
        encodedParams,
        1000000,
        9999,
        callbackGas,
        callbackAddress,
        callbackMethodSelector
    ).send({
        from: fromBlockchain.testAccount,
        gas: 6721975,
        value: 560000000000000 * 20,
    }).on('transactionHash', async (x) => {
        hash = x;
        let transaction = null;
        while (transaction == null) {
            transaction = await blockchains[fromBlockchainId].web3.eth.getTransactionReceipt(hash);
            sleep(1000);
        }
        log.info("RegisterCallInit: ", transaction.gasUsed, ", ", transaction.cumulativeGasUsed);
    }).on('error', console.error);

    while (hash == null) {
        await sleep(5000);
    }

    return true;
}

async function test1() {
    log.info('Scenario 1');
    await intermediary1.start();
    await validator1.start();


    log.info("Reset");
    await reset('ETH1', 'bool', false);
    await registerCall('ETH0', 'ETH1', ['setBool', true]);
    log.info("Call sent, wait");

    // First get newest invocation id
    while (true) {
        await sleep(5000);
        if (blockchains['ETH0'].registered.length > 0) {
            break;
        }
    }
    let invId = blockchains['ETH0'].registered.shift().toString(10);

    log.info("Invocation number: ", invId);

    // Then wait until result is available
    while (true) {
        await sleep(5000);
        if (blockchains['ETH0'].finished.length > 0) {
            let resId = blockchains['ETH0'].finished.shift().toString(10);
            if (invId !== resId) {
                continue;
            }
            break;
        }
    }

    await getValue('ETH1', 'bool');


    await intermediary1.stop();
    await validator1.stop();
}

async function test2() {
    log.info('Scenario 2');
    await intermediary1.start();
    await validator1.start();


    log.info("Reset");
    await reset('ETH1', 'bool', false);
    await reset('ETH2', 'bool', false);
    await registerCall('ETH0', 'ETH1', ['setBool', true]);
    await registerCall('ETH0', 'ETH2', ['setBool', true]);
    log.info("Call sent, wait");

    // First get newest invocation id
    while (true) {
        await sleep(1000);
        if (blockchains['ETH0'].registered.length > 1) {
            break;
        }
    }
    let invId = blockchains['ETH0'].registered.shift().toString(10);
    log.info("Invocation number: ", invId);
    let invId2 = blockchains['ETH0'].registered.shift().toString(10);
    log.info("Invocation number: ", invId2);

    // Then wait until result is available
    while (true) {
        await sleep(1000);
        if (blockchains['ETH0'].finished.length > 1) {
            let resId = blockchains['ETH0'].finished.shift().toString(10);
            // If no match continue
            if (resId !== invId && resId !== invId2) {
                continue;
            }
            let resId2 = blockchains['ETH0'].finished.shift().toString(10);
            // If second no match, push first back and continue
            if (resId2 !== invId && resId2 !== invId2) {
                blockchains['ETH0'].finished.unshift(resId);
                continue;
            }
            break;
        }
    }

    await getValue('ETH1', 'bool');
    await getValue('ETH2', 'bool');

    await intermediary1.stop();
    await validator1.stop();
}

async function test3() {
    log.info('Scenario 3');
    await intermediary1.start();
    await validator1.start();

    await validator1.getBalance('ETH0');
    await intermediary1.getBalance('ETH0');

    log.info("Reset");
    await reset('ETH1', 'text', 'Hello World');
    await registerCall('ETH0', 'ETH1', ['getText']);
    log.info("Call sent, wait");

    // First get newest invocation id
    while (true) {
        await sleep(1000);
        if (blockchains['ETH0'].registered.length > 0) {
            break;
        }
    }
    let invId = blockchains['ETH0'].registered.shift().toString(10);

    log.info("Invocation number: ", invId);

    // Then wait until result is available
    while (true) {
        await sleep(1000);
        if (blockchains['ETH0'].finished.length > 0) {
            let resId = blockchains['ETH0'].finished.shift().toString(10);
            if (invId !== resId) {
                continue;
            }
            break;
        }
    }

    let value = await blockchains['ETH0'].distributionContract.methods.getValue(invId).call();
    if (value[0] === true && value[1] === true) {
        log.info("Result value on blockchain ETH0: '" + value[2] + "', translated: ", blockchains['ETH0'].web3.eth.abi.decodeParameter('string', value[2]));
    } else {
        log.info("Result valid on blockchain ETH0: '" + value[0] + "', result status: '" + value[1] + "'");
    }

    await intermediary1.getBalance('ETH0');
    await validator1.getBalance('ETH0');

    await intermediary1.stop();
    await validator1.stop();
}

async function test4() {
    log.info('Scenario 4');
    await intermediary2.start();
    await intermediary3.start();
    log.info('Start Scenario 1 after starting intermediaries');
    await test1();
    log.info('Scenario 1 end');

    await intermediary2.stop();
    await intermediary3.stop();
    log.info('Scenario 4 end');
}

async function test5() {
    log.info('Scenario 5');
    await validator2.start();
    await validator3.start();
    log.info('Start Scenario 1 after starting validators');
    await test1();
    log.info('Scenario 1 end');

    await validator1.getBalance('ETH0');
    await validator2.getBalance('ETH0');
    await validator3.getBalance('ETH0');

    log.info('Scenario 5 end');
}

async function test6() {
    log.info('Scenario 6');
    await intermediary1.start();
    await validator1.start();


    log.info("Reset");
    await reset('ETH1', 'text', 'Hello World');
    await reset('ETH0', 'text', '');
    await registerCall('ETH0', 'ETH1', ['getText'], 'callbackText');
    log.info("Call sent, wait");

    // First get newest invocation id
    while (true) {
        await sleep(1000);
        if (blockchains['ETH0'].registered.length > 0) {
            break;
        }
    }
    let invId = blockchains['ETH0'].registered.shift().toString(10);

    log.info("Invocation number: ", invId);

    // Then wait until result is available
    while (true) {
        await sleep(1000);
        if (blockchains['ETH0'].finished.length > 0) {
            let resId = blockchains['ETH0'].finished.shift().toString(10);
            if (invId !== resId) {
                continue;
            }
            break;
        }
    }
    await getValue('ETH0', 'text');

    await intermediary1.stop();
    await validator1.stop();
}

async function test7() {
    log.info('Scenario 7');
    await intermediary1.start();
    await validator1.start();


    log.info("Reset");
    await reset('ETH1', 'text', 'Hello World');
    await reset('ETH0', 'text', '');
    await registerCall('ETH0', 'ETH2', ['callGetText'], 'callbackText');
    log.info("Call sent, wait");

    // First get newest invocation id
    while (true) {
        await sleep(1000);
        if (blockchains['ETH0'].registered.length > 0) {
            break;
        }
    }
    let invId = blockchains['ETH0'].registered.shift().toString(10);

    log.info("Invocation number: ", invId);

    // Then wait until result is available
    while (true) {
        await sleep(1000);
        if (blockchains['ETH0'].finished.length > 0) {
            let resId = blockchains['ETH0'].finished.shift().toString(10);
            if (invId !== resId) {
                continue;
            }
            break;
        }
    }
    await getValue('ETH0', 'text');

    await intermediary1.stop();
    await validator1.stop();
}

async function test8() {
    log.info('Scenario 8');
    await intermediary1.start();
    await validator1.start();


    log.info("Reset");
    await reset('ETH2', 'text', '');
    await reset('ETH1', 'text', '');
    await reset('ETH0', 'text', '');
    await registerCall('ETH0', 'ETH2', ['callSetText', 'Hello World'], 'callbackText');
    log.info("Call sent, wait");

    // First get newest invocation id
    while (true) {
        await sleep(1000);
        if (blockchains['ETH0'].registered.length > 0) {
            break;
        }
    }
    let invId = blockchains['ETH0'].registered.shift().toString(10);

    log.info("Invocation number: ", invId);

    // Then wait until result is available
    while (true) {
        await sleep(1000);
        if (blockchains['ETH0'].finished.length > 0) {
            let resId = blockchains['ETH0'].finished.shift().toString(10);
            if (invId !== resId) {
                continue;
            }
            break;
        }
    }
    await getValue('ETH0', 'text');
    await getValue('ETH1', 'text');
    await getValue('ETH2', 'text');

    await intermediary1.stop();
    await validator1.stop();
}

async function test9A() {
    log.info('Scenario 9A');
    intermediary1.setFraud(1);
    await test3();
    intermediary1.setFraud(0);
}

async function test9B() {
    log.info('Scenario 9B');
    intermediary1.setFraud(2);
    await test3();
    intermediary1.setFraud(0);
}

async function test9C() {
    log.info('Scenario 9C');
    intermediary1.setFraud(3);
    await test3();
    intermediary1.setFraud(0);
}

async function test10() {
    log.info('Scenario 10');
    validator1.setFraud(1);
    await test5();
    validator1.setFraud(0);
}

async function test11A() {
    log.info('Scenario 11 A');
    log.info('Cost for executing steps via framework');
    await intermediary1.start();
    await validator1.start();

    await registerCall('ETH0', 'ETH1', ['setBool', true]);
    await registerCall('ETH0', 'ETH1', ['setUint8', 1]);
    await registerCall('ETH0', 'ETH1', ['setUint256', 1]);
    await registerCall('ETH0', 'ETH1', ['setText', "A"]);
    await registerCall('ETH0', 'ETH1', ['setBytes', "0xA"]);
    await registerCall('ETH0', 'ETH1', ['setAddress', "0x0000000000000000000000000000000000000001"]);

    // Then wait until result is available
    while (true) {
        await sleep(1000);
        if (blockchains['ETH0'].finished.length > 5) {
            break;
        }
    }

    blockchains['ETH0'].finished = [];

    await registerCall('ETH0', 'ETH1', ['getBool'], 'setBool');
    await registerCall('ETH0', 'ETH1', ['getUint8'], 'setUint8');
    await registerCall('ETH0', 'ETH1', ['getUint256'], 'setUint256');
    await registerCall('ETH0', 'ETH1', ['getText'], 'setText');
    await registerCall('ETH0', 'ETH1', ['getBytes'], 'setBytes');
    await registerCall('ETH0', 'ETH1', ['getAddress'], 'setAddress');

    // Then wait until result is available
    while (true) {
        await sleep(1000);
        if (blockchains['ETH0'].finished.length > 5) {
            break;
        }
    }

    blockchains['ETH0'].finished = [];


    await intermediary1.stop();
    await validator1.stop();
}

async function executeManual(blockchainID, type, value = null) {
    let transactionHash = null;
    let transaction = null;
    if (value != null) {
        eval("blockchains[blockchainID].testContract.methods."+type)(value).send({
            from: blockchains[blockchainID].account,
            gas: 5000000
        }).on('transactionHash', (x) => {
            transactionHash = x;
        }).on('error', console.error);
    } else {
        eval("blockchains[blockchainID].testContract.methods."+type)().send({
            from: blockchains[blockchainID].account,
            gas: 5000000
        }).on('transactionHash', (x) => {
            transactionHash = x;
        }).on('error', console.error);
    }

    while (transactionHash == null) {
        await sleep(100);
    }
    while (transaction == null) {
        transaction = await blockchains[blockchainID].web3.eth.getTransactionReceipt(transactionHash);
        sleep(1000);
    }
    log.info(type+": ", transaction.gasUsed, ", ", transaction.cumulativeGasUsed);
}
async function test11B() {
    log.info('Scenario 11 B');
    log.info('Cost for executing steps manually');
    // TODO
    await executeManual("ETH1", "setBool", true);
    await executeManual("ETH1", "setUint8", 1);
    await executeManual('ETH1', 'setUint256', 1);
    await executeManual( 'ETH1', 'setText', "A");
    await executeManual( 'ETH1', 'setBytes', "0xA");
    await executeManual( 'ETH1', 'setAddress', "0x0000000000000000000000000000000000000001");

    await executeManual("ETH1", "getBool");
    await executeManual("ETH1", "getUint8");
    await executeManual('ETH1', 'getUint256');
    await executeManual( 'ETH1', 'getText');
    await executeManual( 'ETH1', 'getBytes');
    await executeManual( 'ETH1', 'getAddress');

}

async function setFraudDistanceBlocks(blockchainId, value) {
    let transactionHash = null;
    let transaction = null;

    blockchains[blockchainId].distributionContract.methods.setFraudDistanceBlocks(value).send({
        from: blockchains[blockchainId].account,
        gas: 5000000
    }).on('transactionHash', (x) => {
        transactionHash = x;
    }).on('error', console.error);

    while (transactionHash == null) {
        await sleep(100);
    }

    while (transaction == null) {
        transaction = await blockchains[blockchainId].web3.eth.getTransactionReceipt(transactionHash);
        sleep(1000);
    }

    let waitingBlocks = await blockchains[blockchainId].distributionContract.methods.getFraudDistanceBlocks().call();
    log.info("Set fraudDistanceBlocks blocks on blockchain ", blockchainId, " to ", waitingBlocks.toString(10));

    return waitingBlocks;
}

async function setWaitingBlocks(blockchainId, value) {
    let transactionHash = null;
    let transaction = null;

    blockchains[blockchainId].distributionContract.methods.setWaitingBlocks(value).send({
        from: blockchains[blockchainId].account,
        gas: 5000000
    }).on('transactionHash', (x) => {
        transactionHash = x;
    }).on('error', console.error);

    while (transactionHash == null) {
        await sleep(100);
    }

    while (transaction == null) {
        transaction = await blockchains[blockchainId].web3.eth.getTransactionReceipt(transactionHash);
        sleep(1000);
    }

    let waitingBlocks = await blockchains[blockchainId].distributionContract.methods.getWaitingBlocks().call();
    log.info("Set waiting blocks on blockchain ", blockchainId, " to ", waitingBlocks.toString(10));

    return waitingBlocks;
}

async function setWaitingBlocks2(blockchainId, value) {
    let transactionHash = null;
    let transaction = null;

    blockchains[blockchainId].invocationContract.methods.setWaitingBlocks(value).send({
        from: blockchains[blockchainId].account,
        gas: 5000000
    }).on('transactionHash', (x) => {
        transactionHash = x;
    }).on('error', console.error);

    while (transactionHash == null) {
        await sleep(100);
    }

    while (transaction == null) {
        transaction = await blockchains[blockchainId].web3.eth.getTransactionReceipt(transactionHash);
        sleep(1000);
    }

    let waitingBlocks = await blockchains[blockchainId].invocationContract.methods.getWaitingBlocks().call();
    log.info("Set waiting blocks on blockchain (invocationContract) ", blockchainId, " to ", waitingBlocks.toString(10));

    return waitingBlocks;
}

async function setBlocksPerPhase(blockchainId, value) {
    let transactionHash = null;
    let transaction = null;

    blockchains[blockchainId].distributionContract.methods.setBlocksPerPhase(value).send({
        from: blockchains[blockchainId].account,
        gas: 5000000
    }).on('transactionHash', (x) => {
        transactionHash = x;
    }).on('error', console.error);

    while (transactionHash == null) {
        await sleep(100);
    }


    while (transaction == null) {
        transaction = await blockchains[blockchainId].web3.eth.getTransactionReceipt(transactionHash);
        sleep(1000);
    }

    let blockPerPhase = await blockchains[blockchainId].distributionContract.methods.getBlocksPerPhase().call();
    log.info("Set blockPerPhase blocks on blockchain ", blockchainId, " to ", blockPerPhase.toString(10));

    return blockPerPhase;
}

async function test12() {
    log.info('Scenario 12');

    let step = parseInt(process.argv[3]);
    let stepC = 0;
    let functionId = parseInt(process.argv[4]);

    for (let i of [30, 50, 100]) {
        if (i === 100) {
            //await setFraudDistanceBlocks('ETH0',500);
            //await setFraudDistanceBlocks('ETH1',500);
            //await setFraudDistanceBlocks('ETH2',500);
        }
        for (let j of [5,10,30]) {
            stepC++;
            if (stepC !== step) {
                continue;
            }

            await setWaitingBlocks('ETH0', i);
            await setWaitingBlocks('ETH1', i);
           // await setWaitingBlocks('ETH2', i);
            await setWaitingBlocks2('ETH0', i);
            await setWaitingBlocks2('ETH1', i);
            //await setWaitingBlocks2('ETH2', i);
            await setBlocksPerPhase('ETH0', j);
            await setBlocksPerPhase('ETH1', j);
            //await setBlocksPerPhase('ETH2', j);

            if (functionId === 1) {
                await test1();
            } else if (functionId === 2) {
                await test6();
            } else if (functionId === 3) {
                await test7();
            } else if (functionId === 4) {
                await test8();
            }
        }
    }

    //Reset
    /*await setWaitingBlocks('ETH0', 10);
    await setWaitingBlocks('ETH1', 10);
    await setWaitingBlocks('ETH2', 10);
    await setBlocksPerPhase('ETH0', 10);
    await setBlocksPerPhase('ETH1', 10);
    await setBlocksPerPhase('ETH2', 10);*/

}

async function runTest() {
    console.log(process.argv[2]);
    await eval(process.argv[2])();
    await sleep(2000);

    process.exit();
}

setTimeout(runTest, 0);






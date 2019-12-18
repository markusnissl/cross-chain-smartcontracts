const path = require('path');
const fs = require('fs');
const solc = require('solc');
const Web3 = require("web3");
const net = require('net');
const Tx = require('ethereumjs-tx');

let txCount = {};

function sendSigned(web3, txData, privKey, cb) {
    const privateKey = new Buffer(privKey, 'hex');
    const transaction = new Tx(txData);
    transaction.sign(new Buffer(privateKey, 'hex'));
    const serializedTx = transaction.serialize().toString('hex');
    web3.eth.sendSignedTransaction('0x' + serializedTx, cb);
}

module.exports = {
    loadAbiFile: function (name) {
        const abiPath = path.resolve(__dirname, '..', 'build', name + '.abi');
        const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
        return abi;
    },
    loadBinFile: function (name) {
        const binPath = path.resolve(__dirname, '..', 'build', name + '.bin');
        const bin = fs.readFileSync(binPath, 'utf8');
        return bin;
    },
    compileContract: function (name) {
        const contract = path.resolve(__dirname, '..', 'contracts', name);
        const source = fs.readFileSync(contract, 'UTF-8');
        console.log(solc.compile(source, 1));
    },
    readConfig: function () {
        const config = JSON.parse(fs.readFileSync("../config.json", 'utf8'));
        return config;
    },
    writeConfig: function (data) {
        fs.writeFileSync("../config.json", JSON.stringify(data, null, 2), 'utf8');
    },

    extractEvents: function (web3, abi) {
        events = {};
        abi.filter(function (element) {
            return element.type === 'event';
        }).forEach(function (element) {
            let signature = element.name + '(' + element.inputs.map((x) => x.type).join(',') + ')';
            let hash = web3.utils.soliditySha3(signature);
            events[hash] = element;
        });

        return events;
    },

    sendTx: async function (web3, addressFrom, addressTo, data, value, privKey, cb) {
        let localTxCount = await web3.eth.getTransactionCount(addressFrom);
        if (txCount[addressFrom] == null || txCount[addressFrom] < localTxCount) {
            txCount[addressFrom] = localTxCount;
        } else {
            txCount[addressFrom]++;
        }
        // construct the transaction data
        const txData = {
            nonce: web3.utils.toHex(txCount[addressFrom]),
            gasLimit: web3.utils.toHex(2500000),
            gasPrice: web3.utils.toHex(10e8), // 1 Gwei
            from: addressFrom,
            data: data,
            to: addressTo,
            value: web3.utils.toHex(value),
        };

        //console.log(txData);

        sendSigned(web3, txData, privKey, cb);
    },

    getWeb3: function (blockchain) {
        let web3 = null;
        if (blockchain.provider === 'websocket') {
            web3 = new Web3(new Web3.providers.WebsocketProvider(blockchain.host));
        } else if (blockchain.provider === 'ipc') {
            web3 = new Web3(blockchain.host, net);
        } else if (blockchain.provider === 'http') {
            web3 = new Web3(new Web3.providers.HttpProvider(blockchain.host));
        } else {
            console.log("Provider not supported");
            process.exit(1);
        }
        return web3;
    }

}
;

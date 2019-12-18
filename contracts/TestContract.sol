pragma solidity ^0.5.7;

import "./DistributionContract.sol";

contract TestContract {

	DistributionContract distributionContract;

	bytes test0;
	bytes test1;
	bytes test2;

	bool status = false;
	uint8 smallInt = 0;
	uint256 bigInt = 0;
	string text = "";
	bytes data = hex"";
	address addr = address(0);

	function setAddresses(address distributionContractAddress, address addr0, address addr1, address addr2) public {
		distributionContract = DistributionContract(distributionContractAddress);
		test0 = abi.encodePacked(addr0);
		test1 = abi.encodePacked(addr1);
		test2 = abi.encodePacked(addr2);
	}

	function setBool(bool _status) public {
		status = _status;
	}

	function setUint8(uint8 _smallInt) public {
		smallInt = _smallInt;
	}

	function setUint256(uint256 _bigInt) public {
		bigInt = _bigInt;
	}

	function setText(string memory _text) public {
		text = _text;
	}

	function setBytes(bytes memory _data) public {
		data = _data;
	}

	function setAddress(address _addr) public {
		addr = _addr;
	}

	function getBool() view public returns(bool) {
		return status;
	}

	function getUint8() view public returns(uint8) {
		return smallInt;
	}

	function getUint256() view public returns(uint256) {
		return bigInt;
	}

	function getText() view public returns(string memory) {
		return text;
	}

	function getBytes() view public returns(bytes memory) {
		return data;
	}

	function getAddress() view public returns(address) {
		return addr;
	}

	function callbackText(uint256 invocationId) public returns(string memory) {
		(bool valid, bool resultStatus, bytes memory result) = distributionContract.getValue(invocationId);
		if (valid && resultStatus) {
			text = abi.decode(result, (string));
		}
		return text;
	}

	function callSetText(string memory _text) public returns (bytes32) {
		bytes memory params = abi.encodeWithSignature("setText(string)", _text);
		distributionContract.registerCall.value(3000000000000000)("ETH1", test1, params, 50000, 1000, 5000000, address(this), bytes4(keccak256(bytes("callback1(uint256)"))));
		return hex"cafefeedcafefeedcafefeedcafefeedcafefeedcafefeedcafefeedcafefeed";
	}

	function callback1(uint256 invocationId) public returns (bytes32) {
		(bool valid, bool resultStatus,) = distributionContract.getValue(invocationId);
		if (valid && resultStatus) {
			bytes memory params = abi.encodeWithSignature("getText()");
			distributionContract.registerCall.value(3000000000000000)("ETH1", test1, params, 50000, 1000, 5000000, address(this), bytes4(keccak256(bytes("callbackText(uint256)"))));
			return hex"cafefeedcafefeedcafefeedcafefeedcafefeedcafefeedcafefeedcafefeed";
		}
	}

	function callGetText() public returns (bytes32) {
		bytes memory params = abi.encodeWithSignature("getText()");
		distributionContract.registerCall.value(3000000000000000)("ETH1", test1, params, 50000, 1000, 0, address(0), "");
		return hex"cafefeedcafefeedcafefeedcafefeedcafefeedcafefeedcafefeedcafefeed";
	}

	// Default function payable
	function() external payable {}

}
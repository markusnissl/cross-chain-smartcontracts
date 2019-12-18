pragma solidity ^0.5.6;

interface IIC {
	function updateResult(uint resultId, bool success, bytes calldata resultData) external;
	function finalResult(uint resultId, uint8 status, bytes calldata resultData) external;
}
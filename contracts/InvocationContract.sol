pragma solidity ^0.5.6;
import "./external/BytesLib.sol";
import "./IDC.sol";
import "./IIC.sol";

contract InvocationContract is IIC {
	using BytesLib for bytes;

	enum ResultStatus {
		ExecutionFailed,
		ExecutionFinished,
		ExecutionWaiting
	}

	enum ResultPhases {
		ExecutionNotStarted,
		ExecutionVerifying,
		ExecutionVerified
	}

	struct ResultInfo {
		bytes4 sourceId;
		address sender;
		address contractAddress;
		uint invocationId;
		uint gasprice;
		uint maxSteps;
		bytes parameters;
		uint startBlock;
		ResultStatus status;
		bytes resultData;
		uint requiredSteps;
	}

	// State variables
	uint private numResults = 0;
	uint private waitingBlocks = 10;
	bytes waitingCode = hex"cafefeedcafefeedcafefeedcafefeedcafefeedcafefeedcafefeedcafefeed";
	IDC private distributionContract;

	address private _owner = msg.sender;
	
	mapping(uint => ResultInfo) private results;

	// Events
	event NewExecuteResult(address sender, uint resultId);
	event NewExecuteUpdate(address sender, uint resultId);

	// Functions

	function setDistributionContract(address distributionContractAddress) external {
		require(msg.sender == _owner, "only owner can set distributionContract address");
		distributionContract = IDC(distributionContractAddress);
	}

	function setWaitingBlocks(uint wB) external {
		waitingBlocks = wB;
	}

	function getWaitingBlocks() public view returns (uint) {
		return waitingBlocks;
	}

	function executeCall(bytes4 sourceId, address contractAddress, uint invocationId, uint maxSteps, bytes calldata parameters) external payable returns (uint resultId) {
		resultId = ++numResults;
		uint gasStart = gasleft();
		uint tmp = distributionContract.getLastInvocationId();
		(bool success, bytes memory resultData) = contractAddress.call.value(msg.value).gas(maxSteps)(parameters);
		ResultStatus status = ResultStatus.ExecutionFailed;
		if (success) {
			if (distributionContract.getLastInvocationId() > tmp && waitingCode.equalStorage(resultData)) {
				status = ResultStatus.ExecutionWaiting;
				distributionContract.registerNotifyOnResult(resultId);
			} else {
				status = ResultStatus.ExecutionFinished;
			}
		}
		results[resultId] = ResultInfo(sourceId, msg.sender, contractAddress, invocationId, tx.gasprice, maxSteps, parameters, block.number, status, resultData, 0);
		uint gasStop = gasleft();
		results[resultId].requiredSteps = gasStart - gasStop;
		emit NewExecuteResult(msg.sender, resultId);
	}


	function updateResult(uint resultId, bool success, bytes calldata resultData) external {
		require(msg.sender == address(distributionContract), "Only distributionContract can call this function");

		ResultStatus status = ResultStatus.ExecutionFailed;

		if (success) {
			if (waitingCode.equalStorage(resultData)) {
				status = ResultStatus.ExecutionWaiting;
				distributionContract.registerNotifyOnResult(resultId);
			} else {
				status = ResultStatus.ExecutionFinished;
				// Update block number only if final result is received.
				results[resultId].startBlock = block.number;
			}
		}

		results[resultId].status = status;
		results[resultId].resultData = resultData;
		
		emit NewExecuteUpdate(results[resultId].sender, resultId);
	}

	function finalResult(uint resultId, uint8 status, bytes calldata resultData) external {
		require(msg.sender == address(distributionContract), "Only distributionContract can call this function");

		results[resultId].status = ResultStatus(status);
		results[resultId].resultData = resultData;
		// Update block number
		results[resultId].startBlock = block.number;
		emit NewExecuteUpdate(results[resultId].sender, resultId);
	}


	function getResultInfo(uint resultId) public view returns (bytes4 sourceId, address sender, address contractAddress, uint invocationId, uint gasprice, uint maxSteps, bytes memory parameters, uint startBlock, ResultStatus status, bytes memory resultData, uint requiredSteps) {
		ResultInfo memory resultInfo = results[resultId];
		return (resultInfo.sourceId, resultInfo.sender, resultInfo.contractAddress, resultInfo.invocationId, resultInfo.gasprice, resultInfo.maxSteps, resultInfo.parameters, resultInfo.startBlock, resultInfo.status, resultInfo.resultData, resultInfo.requiredSteps);
	}

	function getResultPhase(uint resultId) public view returns (ResultPhases) {
		if (results[resultId].sender == address(0)) {
			return ResultPhases.ExecutionNotStarted;
		}

		if (results[resultId].startBlock + waitingBlocks >= block.number) {
			return ResultPhases.ExecutionVerifying;
		}

		return ResultPhases.ExecutionVerified;
	}

}
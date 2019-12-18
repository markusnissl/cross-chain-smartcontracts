pragma solidity ^0.5.6;
import "./IDC.sol";
import "./IIC.sol";

contract DistributionContract is IDC {

	// Structs
	struct CallInfo {
		address payable sender;
		bytes4 blockchainId;
		bytes contractId;
		bytes parameters;
		uint maxSteps;
		uint maxGasPrice;
		uint startBlock;
		uint gasValue;
		uint callbackSteps;
		uint callbackGasprice;
		address callbackAddress;
		bytes4 callbackMethodSelector;
	}

	struct Offer {
		address payable offerer;
		uint gasPrice;
	}

	struct ResultInfo {
		uint resultId;
		ResultStatus status;
		bytes resultData;
		uint requiredSteps;
		bool created;
		bool finalized;
		bool valid;
		uint startBlock;
		uint votingId;
		uint fraudVotingId;
	}

	struct VotingInfo {
		uint startBlock;
		uint firstVotingBlock;
		bool finalized;
		mapping (uint8 => VoteCode) voteCodes;
		mapping (address => bool) voters;
	}

	struct VoteCode {
		uint votes;
		bytes32 signature;
		address payable winner;
	}

	// Enums
	enum CallStatus {
		PreOfferPhase, // forbidden to make offer since not sure that register transaction is already confirmed
		OfferPhase,
		PreTransactionPhase, // not forbidden by design to start since not sure if winner is already confirmed correctly. Publishing result not allowed in this phase.
		TransactionPhase,
		PreVotingPhase, // forbidden to start voting, since result may not be valid and may be overwritten
		VotingPhase,
		PostVotingPhase, // forbidden to finalize because result may change
		WaitForFinalization,
		Finalized
	}

	enum ResultStatus {
		ExecutionFailed,
		ExecutionFinished,
		ExecutionWaiting
	}

	enum VotePhases {
		PreVoting,
		Voting,
		PostVoting,
		WaitForFinalization,
		Finalized
	}

	// Not used, only for info
	enum VotingStatusCode {
		ResultWrong,
		WrongParams,
		Ok,
		OutOfTime
	}

	// Events
	event NewCallRequest(uint invocationId);
	event NewBestOffer(uint invocationId);
	event ResultRegistered(uint invocationId);
	event ResultAvailable(address sender, uint invocationId);
	event CallFinished(uint invocationId);
	event ContinuedResult(uint invocationId, bool success);
	event FraudVotingStarted(uint invocationId);
	event NewFraudVotingWinner(uint invocationId, address winner);

	// State variables
	uint private invocationCounter = 0;
	uint private votingCounter = 0;
	uint private blocksPerPhase = 10;
	uint private waitingBlocks = 10;
	uint private fraudDistanceBlocks = 100;
	IIC private invocationContract;

	// Transaction cost fee at 2019-04-24: https://bitinfocharts.com/de/ethereum/
	uint private intermediaryFee = 560000000000000;
	uint private votingFee = 560000000000000;

	address private _owner = msg.sender;

	mapping(uint => CallInfo) private callings;
	mapping(uint => Offer) private offers;
	mapping(uint => ResultInfo) private results;
	mapping(uint => VotingInfo) private votings;

	mapping(address => uint) private deposits;

	// Invoking chain handling
	mapping(uint => uint) private listeners;

	// Functions
	function setInvocationContract(address invocationContractAddress) external {
		require(msg.sender == _owner, "only owner can set invocationContract address");
		invocationContract = IIC(invocationContractAddress);
	}

	function registerNotifyOnResult(uint resultId) external {
		require(msg.sender == address(invocationContract), "Only invocationContract can call this function");
		listeners[invocationCounter] = resultId;
	}


	function depositCoins() external payable {
		deposits[msg.sender] += msg.value;
	}

	function withdrawCoins() external {
		uint amount = deposits[msg.sender];
        deposits[msg.sender] = 0;
        msg.sender.transfer(amount);
	}

	function setWaitingBlocks(uint wB) external {
		waitingBlocks = wB;
	}

	function getWaitingBlocks() public view returns (uint) {
		return waitingBlocks;
	}

	function setBlocksPerPhase(uint bPP) external {
		blocksPerPhase = bPP;
	}

	function getBlocksPerPhase() public view returns (uint) {
		return blocksPerPhase;
	}

	function setFraudDistanceBlocks(uint fDP) external {
		fraudDistanceBlocks = fDP;
	}

	function getFraudDistanceBlocks() public view returns (uint) {
		return fraudDistanceBlocks;
	}

	/**
	 *
	 * Needed to find a way for dealing with local variables due to stack size error: CompilerError: Stack too deep, try removing local variables.
	 * https://github.com/ethereum/solidity/issues/3060 modifiers count to stack
	 * Inline require checks
	 */
	function registerCall(bytes4 blockchainId, bytes calldata contractId, bytes calldata parameters, uint maxSteps, uint maxGasPrice, uint callbackSteps, address callbackAddress, bytes4 callbackMethodSelector) external  payable returns (uint invocationId) {
		// 2 times intermediaryFee for additonal gas needed for logging
		require(msg.value > maxSteps * maxGasPrice + 2*intermediaryFee + votingFee + callbackSteps*tx.gasprice, "Deposited value not enough for max values");

		invocationId = ++invocationCounter;
		callings[invocationId] = CallInfo(msg.sender, blockchainId, contractId, parameters, maxSteps, maxGasPrice, block.number, msg.value, callbackSteps, tx.gasprice, callbackAddress, callbackMethodSelector);


		// Init fraud voting params
		uint votingId = ++votingCounter;
		results[invocationId].fraudVotingId = votingId;
		votings[votingId] = VotingInfo(block.number + waitingBlocks + waitingBlocks + blocksPerPhase + fraudDistanceBlocks,0,false);
		// OK
		votings[votingId].voteCodes[2] = VoteCode(0, 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff, address(0));
		// Transaction out of time
		votings[votingId].voteCodes[3] = VoteCode(0, 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff, address(0));

		emit NewCallRequest(invocationId);
	}

	function makeOffer(uint invocationId, uint gasPrice) external {
		require (callings[invocationId].sender != address(0), "Cannot submit offer for unknown calling");
		require (getPhase(invocationId) == CallStatus.OfferPhase, "Cannot submit offer while not in offering phase");
		require (callings[invocationId].maxGasPrice >= gasPrice);
		require(deposits[msg.sender] >= votingFee + intermediaryFee, "Not enough coins deposited to make offer");

		if (offers[invocationId].offerer == address(0)
			|| (callings[invocationId].maxSteps * offers[invocationId].gasPrice) > (callings[invocationId].maxSteps * gasPrice)
			|| ((callings[invocationId].maxSteps * offers[invocationId].gasPrice) == (callings[invocationId].maxSteps * gasPrice) && getSignature(msg.sender, invocationId) < getSignature(offers[invocationId].offerer, invocationId))
		) {
			if (offers[invocationId].offerer != address(0)) {
				deposits[offers[invocationId].offerer] += (intermediaryFee + votingFee);
			}
			offers[invocationId] = Offer(msg.sender, gasPrice);
			deposits[offers[invocationId].offerer] -= (intermediaryFee + votingFee);

			emit NewBestOffer(invocationId);
		}
	}

	function registerResult(uint invocationId, uint resultId) external {
		require (getPhase(invocationId) == CallStatus.TransactionPhase, "Cannot submit result while in offer phase");
		require (msg.sender == offers[invocationId].offerer, "Only offer winner can call this function");
		require (results[invocationId].created == false, "Cannot resubmit result");
		require(results[invocationId].resultId == 0, "You can submit result info only once");
		uint votingId = results[invocationId].fraudVotingId;

		// Fraud behaviour
		require(votings[votingId].startBlock >= block.number, "You can submit result info only in time");
		results[invocationId].resultId = resultId;
		// Reset voting startBlock as soon as result was registered
		votings[votingId].startBlock = block.number + fraudDistanceBlocks;

		emit ResultRegistered(invocationId);
	}

	function submitResult(uint invocationId, uint resultId, ResultStatus status, bytes calldata resultData, uint requiredSteps) external {
		require (getPhase(invocationId) == CallStatus.TransactionPhase, "Cannot submit result while in offer phase");
		require (msg.sender == offers[invocationId].offerer, "Only offer winner can call this function");
		require (results[invocationId].created == false, "Cannot resubmit result");
		require(results[invocationId].resultId == 0 || results[invocationId].resultId == resultId, "You cannot change result id");
		uint fraudVotingId = results[invocationId].fraudVotingId;
		require(results[invocationId].resultId != 0 || votings[fraudVotingId].startBlock >= block.number, "You can submit result info only in time");

		uint votingId = ++votingCounter;
		votings[votingId] = VotingInfo(block.number + waitingBlocks, 0, false);
		// neg
		votings[votingId].voteCodes[0] = VoteCode(0, 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff, address(0));
		// result ok
		votings[votingId].voteCodes[1] = VoteCode(0, 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff, address(0));
		// result ok and gas ok
		votings[votingId].voteCodes[2] = VoteCode(0, 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff, address(0));

		results[invocationId] = ResultInfo(resultId, status, resultData, requiredSteps, true, false, false, block.number, votingId, results[invocationId].fraudVotingId);


		// Stop fraud voting on result, no fees are paid
		votings[fraudVotingId].finalized = true;
		if (votings[fraudVotingId].voteCodes[3].votes > 0) {
			deposits[votings[fraudVotingId].voteCodes[3].winner] += votingFee;
		}
		if (votings[fraudVotingId].voteCodes[2].votes > 0) {
			deposits[votings[fraudVotingId].voteCodes[2].winner] += votingFee;
		}

		emit ResultAvailable(msg.sender, invocationId);
	}

	function vote(uint invocationId, uint8 validCode) external {
		require (votings[results[invocationId].votingId].voters[msg.sender] == false, "Cannot vote twice");
		require (msg.sender != offers[invocationId].offerer, "Cannot be offerer and voter at the same time");
		require (validCode == 0 || validCode == 1 || validCode == 2, "Voting Code must be allowed");
		require (getPhase(invocationId) == CallStatus.VotingPhase, "Cannot submit voting while not in voting phase");
		uint votingId = results[invocationId].votingId;
		votings[votingId].voters[msg.sender] = true;
		votings[votingId].voteCodes[validCode].votes++;
		bytes32 signature = getSignature(msg.sender, invocationId);
		if (signature < votings[votingId].voteCodes[validCode].signature) {
			votings[votingId].voteCodes[validCode].winner = msg.sender;
		}
		if (votings[votingId].firstVotingBlock < votings[votingId].startBlock) {
			votings[votingId].firstVotingBlock = block.number;
		}
	}

	function fraudVote(uint invocationId, uint8 validCode) external {
		require (msg.sender != offers[invocationId].offerer, "Cannot be offerer and voter at the same time");
		require (validCode == 2 || validCode == 3, "Voting Code must be allowed");
		require (getPhase(invocationId) == CallStatus.TransactionPhase, "Can only submit fraud voting while in transaction phase");

		uint votingId = results[invocationId].fraudVotingId;
		require (votings[votingId].voters[msg.sender] == false, "Cannot vote twice");
		require (getFraudDetectionPhase(invocationId) == VotePhases.Voting, "Can only vote in correct phase");
		require(deposits[msg.sender] >= votingFee, "Can only vote if deposit is higher or equal than votingFee");

		if (votings[votingId].firstVotingBlock < votings[votingId].startBlock) {
			votings[votingId].firstVotingBlock = block.number;
			emit FraudVotingStarted(invocationId);
		}

		require (votings[votingId].firstVotingBlock + blocksPerPhase >= block.number, "Fraud voting has already ended");

		votings[votingId].voters[msg.sender] = true;
		votings[votingId].voteCodes[validCode].votes++;
		bytes32 signature = getSignature(msg.sender, invocationId);
		if (signature < votings[votingId].voteCodes[validCode].signature) {
			if (votings[votingId].voteCodes[validCode].winner != address(0)) {
				deposits[votings[votingId].voteCodes[validCode].winner] += votingFee;
			}
			votings[votingId].voteCodes[validCode].winner = msg.sender;
			deposits[msg.sender] -= votingFee;
			emit NewFraudVotingWinner(invocationId, msg.sender);
		}
	}

	function finalizeFraudVoting(uint invocationId) external {
		require (getFraudDetectionPhase(invocationId) == VotePhases.WaitForFinalization, "Can only finalize fraud voting in correct phase");
		uint votingId = results[invocationId].fraudVotingId;
		votings[votingId].finalized = true;

		if (votings[votingId].voteCodes[3].votes > votings[votingId].voteCodes[2].votes) {
			results[invocationId].created = true;
			results[invocationId].finalized = true;
			results[invocationId].valid = false;

			// Trigger calls
			triggerCalling(invocationId);

			// Give deposit back
			if (votings[votingId].voteCodes[2].votes > 0) {
				deposits[votings[votingId].voteCodes[2].winner] += votingFee;
			}
			deposits[votings[votingId].voteCodes[3].winner] += votingFee;

			// The interemediary has funded a deposit for the misbehaviour. The value is truncated there. The caller gets also a fee from the intermediary
			votings[votingId].voteCodes[3].winner.transfer(votingFee);
			callings[invocationId].sender.transfer(intermediaryFee);

			emit CallFinished(invocationId);
		} else {
			// It makes no sense, that someone starts voting for ok, so there must be one who has started voting for not ok, so there must be a winner for the other voting
			// This wrong winner has to pay the fee, if no winner exists, no fee is paid at all

			// Give deposit back
			deposits[votings[votingId].voteCodes[2].winner] += votingFee;

			if (votings[votingId].voteCodes[3].votes > 0) {
				votings[votingId].voteCodes[2].winner.transfer(votingFee);
			}
			// Reset voting
			votings[votingId].startBlock = block.number + fraudDistanceBlocks;
			votings[votingId].firstVotingBlock = 0;
			votings[votingId].voteCodes[2] = VoteCode(0, 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff, address(0));
			votings[votingId].voteCodes[3] = VoteCode(0, 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff, address(0));
		}

	}

	function triggerCalling(uint invocationId) private {
		// Is there any method, which should be called afterwards?
		if (callings[invocationId].callbackAddress != address(0)) {
			uint gasStart = gasleft();

			uint tmp = invocationCounter;

			(bool success, bytes memory resultData) = callings[invocationId].callbackAddress.call.gas(callings[invocationId].callbackSteps)(abi.encodeWithSelector(callings[invocationId].callbackMethodSelector, invocationId));
			emit ContinuedResult(invocationId, success);
			if (listeners[invocationId] > 0) {
				// There was only a call if invocationCounter is greater than before the function call.
				if (invocationCounter > tmp) {
					invocationContract.updateResult(listeners[invocationId], success, resultData);
				} else {
					invocationContract.finalResult(listeners[invocationId], success?1:0, resultData);
				}
			}
			uint gasStop = gasleft();
			// If it is executed with higher transaction price it is a problem of the sender, it is possible to execute lower it is a benefit for the sender
			uint finalizeFunctionGas = (gasStart-gasStop) * callings[invocationId].callbackGasprice;
			callings[invocationId].gasValue -= finalizeFunctionGas;
			msg.sender.transfer(finalizeFunctionGas);
		} else {
			if (listeners[invocationId] > 0) {
				// Pass received result back
				invocationContract.finalResult(listeners[invocationId], uint8(results[invocationId].status), results[invocationId].resultData);
			}
		}
	}

	function finalize(uint invocationId) external {
		require (getPhase(invocationId) == CallStatus.WaitForFinalization, "Cannot finalize voting while not in correct phase");
		results[invocationId].finalized = true;
		uint votingId = results[invocationId].votingId;
		votings[votingId].finalized = true;

		// If no offer was made finalize directly without paying anything to others.
		if (offers[invocationId].offerer != address(0)) {
			if (votings[votingId].voteCodes[1].votes + votings[votingId].voteCodes[2].votes > votings[votingId].voteCodes[0].votes) {
				results[invocationId].valid = true;

				if (votings[votingId].voteCodes[1].votes > votings[votingId].voteCodes[2].votes) {
					// Fee paid by intermediary
					votings[votingId].voteCodes[1].winner.transfer(votingFee);
					callings[invocationId].sender.transfer(intermediaryFee);
				} else {
					//Give deposit back to intermediary
					deposits[offers[invocationId].offerer] += (votingFee + intermediaryFee);

					callings[invocationId].gasValue -= votingFee;
					votings[votingId].voteCodes[2].winner.transfer(votingFee);

					// Pay needed value to offerer
					uint payGas = results[invocationId].requiredSteps * offers[invocationId].gasPrice + intermediaryFee;
					callings[invocationId].gasValue -= payGas;
					offers[invocationId].offerer.transfer(payGas);
				}
			} else {
				results[invocationId].valid = false;
				votings[votingId].voteCodes[0].winner.transfer(votingFee);
				callings[invocationId].sender.transfer(intermediaryFee);
			}
		} else {
			// Pay a fee to that user that has executed this function to finalize the status
			callings[invocationId].gasValue -= votingFee;
			msg.sender.transfer(votingFee);
		}

		triggerCalling(invocationId);


		callings[invocationId].sender.transfer(callings[invocationId].gasValue);
		callings[invocationId].gasValue = 0;

		emit CallFinished(invocationId);
	}


	function getSignature(address sender, uint invocationId) public pure returns (bytes32) {
		return keccak256(abi.encodePacked(sender, invocationId));
	}

	function getLastInvocationId() external view returns (uint) {
		return invocationCounter;
	}

	function getValue(uint invocationId) public view returns (bool valid, bool status, bytes memory) {
		return (results[invocationId].valid, results[invocationId].status==ResultStatus.ExecutionFinished, results[invocationId].resultData);
	}

	function getCallInfo(uint invocationId) public view returns (bytes4 blockchainId, bytes memory contractId, bytes memory parameters, uint maxSteps, uint maxGasPrice, uint startBlock, address callbackAddress, bytes4 callbackMethodSelector, uint callbackSteps) {
		CallInfo memory callInfo = callings[invocationId];
		return (callInfo.blockchainId, callInfo.contractId, callInfo.parameters, callInfo.maxSteps, callInfo.maxGasPrice, callInfo.startBlock, callInfo.callbackAddress, callInfo.callbackMethodSelector, callInfo.callbackSteps);
	}

	function getOffer(uint invocationId) public view returns (address offerer, uint gasPrice) {
		Offer memory offer = offers[invocationId];
		return (offer.offerer, offer.gasPrice);
	}

	function getResultInfo(uint invocationId) public view returns (uint resultId, ResultStatus status, bytes memory resultData, uint requiredSteps, uint startBlock) {
		ResultInfo memory resultInfo = results[invocationId];

		return (resultInfo.resultId, resultInfo.status, resultInfo.resultData, resultInfo.requiredSteps, resultInfo.startBlock);
	}

	function getPhase(uint invocationId) public view returns (CallStatus) {
		if (callings[invocationId].startBlock + waitingBlocks >= block.number) {
			return CallStatus.PreOfferPhase;
		}
		if (callings[invocationId].startBlock + waitingBlocks + blocksPerPhase >= block.number) {
			return CallStatus.OfferPhase;
		}
		if (callings[invocationId].startBlock + waitingBlocks + blocksPerPhase + waitingBlocks >= block.number) {
			return CallStatus.PreTransactionPhase;
		}

		// No offer made, payback possible
		if (offers[invocationId].offerer == address(0)) {
			if (results[invocationId].finalized) {
				return CallStatus.Finalized;
			} else {
				return CallStatus.WaitForFinalization;
			}
		}

		if (results[invocationId].created == false) {
			return CallStatus.TransactionPhase;
		}
		if (results[invocationId].finalized == true) {
			return CallStatus.Finalized;
		}

		uint votingId = results[invocationId].votingId;
		VotePhases votingPhase = getVotingPhase(votingId);
		if (votingPhase == VotePhases.PreVoting) {
			return CallStatus.PreVotingPhase;
		}
		if (votingPhase == VotePhases.Voting) {
			return CallStatus.VotingPhase;
		}
		if (votingPhase == VotePhases.PostVoting) {
			return CallStatus.PostVotingPhase;
		}

		return CallStatus.WaitForFinalization;
	}

	function getVotingPhase(uint votingId) public view returns (VotePhases) {
		// Already finalized
		if (votings[votingId].finalized) {
			return VotePhases.Finalized;
		}

		// voting phase not reached until now
		if (votings[votingId].startBlock >= block.number) {
			return VotePhases.PreVoting;
		}

		// In voting phase
		if (votings[votingId].firstVotingBlock < votings[votingId].startBlock ||
			votings[votingId].firstVotingBlock + blocksPerPhase >= block.number
		) {
			return VotePhases.Voting;
		}

		// Wait until finalize possible
		if (votings[votingId].firstVotingBlock + blocksPerPhase + waitingBlocks >= block.number) {
			return VotePhases.PostVoting;
		}


		return VotePhases.WaitForFinalization;
	}

	function getFraudDetectionPhase(uint invocationId) public view returns (VotePhases) {
		return getVotingPhase(results[invocationId].fraudVotingId);
	}

	function getFraudVotingInfo(uint invocationId) public view returns (uint8 winnerCode, address winner, uint votes, uint totalVotes) {
		uint votingId = results[invocationId].fraudVotingId;
		if (votings[votingId].voteCodes[3].votes > votings[votingId].voteCodes[2].votes) {
			return (3, votings[votingId].voteCodes[3].winner, votings[votingId].voteCodes[3].votes, votings[votingId].voteCodes[3].votes + votings[votingId].voteCodes[2].votes);
		}
		return (2, votings[votingId].voteCodes[2].winner, votings[votingId].voteCodes[2].votes, votings[votingId].voteCodes[2].votes + votings[votingId].voteCodes[3].votes);
	}

	// Not implemented:
	/*
	// This function is not implemented since a decision should not be revoked
	function abort() {

	}
	*/
}

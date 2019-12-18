pragma solidity ^0.5.6;

interface IDC {
    function registerNotifyOnResult(uint resultId) external;
    function getLastInvocationId() external view returns (uint);
}


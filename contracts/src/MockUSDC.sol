// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MockStablecoin} from "./MockStablecoin.sol";

contract MockUSDC is MockStablecoin {
    constructor(address owner_) MockStablecoin("Mock USDC", "mUSDC", owner_) {}
}

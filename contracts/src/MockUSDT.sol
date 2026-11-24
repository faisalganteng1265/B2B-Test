// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MockStablecoin} from "./MockStablecoin.sol";

contract MockUSDT is MockStablecoin {
    constructor(address owner_) MockStablecoin("Mock USDT", "mUSDT", owner_) {}
}

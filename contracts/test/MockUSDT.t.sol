// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockUSDT} from "../src/MockUSDT.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

contract MockUSDTTest is Test {
    MockUSDT internal usdt;
    MockUSDC internal usdc;
    address internal owner = address(0xA11CE);
    address internal alice = address(0xB0B);
    address internal bob = address(0xCAFE);

    function setUp() public {
        usdt = new MockUSDT(owner);
        usdc = new MockUSDC(owner);
    }

    function test_Decimals() public view {
        assertEq(usdt.decimals(), 6);
        assertEq(usdc.decimals(), 6);
        assertEq(usdt.symbol(), "mUSDT");
        assertEq(usdc.symbol(), "mUSDC");
    }

    function test_OwnerCanMint() public {
        vm.prank(owner);
        usdt.mint(alice, 1_000e6);
        assertEq(usdt.balanceOf(alice), 1_000e6);
        assertEq(usdt.totalSupply(), 1_000e6);
    }

    function test_RevertWhen_NonOwnerMints() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        usdt.mint(alice, 1);
    }

    function test_TransferEmitsEvent() public {
        vm.prank(owner);
        usdt.mint(alice, 500e6);
        vm.expectEmit(true, true, false, true, address(usdt));
        emit IERC20.Transfer(alice, bob, 123_456_789);
        vm.prank(alice);
        usdt.transfer(bob, 123_456_789);
        assertEq(usdt.balanceOf(bob), 123_456_789);
    }

    function testFuzz_MintTransfer(uint96 amount) public {
        vm.prank(owner);
        usdt.mint(alice, amount);
        vm.prank(alice);
        usdt.transfer(bob, amount);
        assertEq(usdt.balanceOf(bob), amount);
        assertEq(usdt.balanceOf(alice), 0);
    }
}

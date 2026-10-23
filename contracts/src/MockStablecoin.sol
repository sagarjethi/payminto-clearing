// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @notice Local-development stand-in for HashKey Chain USDC (6 decimals, EIP-2612). Never deployed to a live network.
contract MockStablecoin is ERC20, ERC20Permit {
    constructor() ERC20("USD Coin", "USDC") ERC20Permit("USD Coin") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// Open faucet: local chains only.
    function mint(address to, uint256 amount) external {
        require(block.chainid == 31337, "local only");
        _mint(to, amount);
    }
}

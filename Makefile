SHELL := /bin/bash
.PHONY: deps up down reset deploy seed test test-contracts

deps:            ## install JS deps + foundry libs
	pnpm install
	cd contracts && [ -d lib/forge-std ] || forge install foundry-rs/forge-std --no-git
	cd contracts && [ -d lib/openzeppelin-contracts ] || forge install OpenZeppelin/openzeppelin-contracts@v5.4.0 --no-git

deploy:          ## deploy mock tokens to $$CHAIN (Base Sepolia), writes deployments/<chainId>.json
	./scripts/deploy.sh

test-contracts:
	cd contracts && forge test

test: test-contracts
	pnpm test

// Contract interfaces the provider identity helper calls.

import { parseAbi, parseAbiItem } from "viem";

export const identityAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);
// ERC-721 mint/transfer: register() emits one with the registering wallet as
// `to`, which is how an existing id is recovered without a reverse lookup.
export const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
);
export const agentIndexAbi = parseAbi([
  "function resolve(address wallet) view returns (uint256)",
  "function claim(uint256 agentId)",
]);
export const provAbi = parseAbi([
  "function listingFee() view returns (uint256)",
  "function register(uint256 agentId)",
  "function isRegistered(uint256) view returns (bool)",
]);
export const usdcAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address,uint256) returns (bool)",
]);

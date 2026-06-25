// fund-roster.js — oracle から roster アドレスへ初期種銭(testnet only / 不足分のみ補填=冪等)
// usage: node --import tsx/esm fund-roster.js
import 'dotenv/config';
import { createWalletClient, http, parseUnits, parseEther, parseAbi, formatEther, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getPublicClient, arcChain } from './protocol/arc.js';

const USDC_ADDRESS = process.env.USDC_ADDRESS;
const USDC_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

// 配布先と目標残高(不足分のみ補填)。Phase2で PHONEST/PLIAR/XCHAL を解禁。
const TARGETS = [
  { role: 'PCHEAP', eth: '0.1', usdc: '5' },
  { role: 'PHONEST', eth: '0.1', usdc: '5' },
  { role: 'PLIAR',   eth: '0.1', usdc: '5' },
  { role: 'PCONF',   eth: '0.1', usdc: '5' },
  { role: 'PCONF_CONSUMER', eth: '0.1', usdc: '5' },
  // { role: 'XCHAL',   eth: '0.1', usdc: '5' },
];

const pub = getPublicClient();
const chain = arcChain;
const oracleAcct = privateKeyToAccount(process.env.ORACLE_PRIVATE_KEY);
const oracle = createWalletClient({ account: oracleAcct, chain, transport: http(process.env.ARC_RPC_URL) });
const dec = await pub.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'decimals' });

async function send(role, ethTarget, usdcTarget) {
  const to = privateKeyToAccount(process.env[`${role}_PRIVATE_KEY`]).address;
  const ethNeed = parseEther(ethTarget);
  const usdcNeed = parseUnits(usdcTarget, dec);
  const ethBal = await pub.getBalance({ address: to });
  const usdcBal = await pub.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'balanceOf', args: [to] });

  if (ethBal < ethNeed) {
    const amt = ethNeed - ethBal;
    const hash = await oracle.sendTransaction({ to, value: amt, chain });
    await pub.waitForTransactionReceipt({ hash });
    console.log(`[fund] ${role} +${formatEther(amt)} ETH  tx=${hash}`);
  } else {
    console.log(`[fund] ${role} ETH ok (${formatEther(ethBal)})`);
  }

  if (usdcBal < usdcNeed) {
    const amt = usdcNeed - usdcBal;
    const hash = await oracle.writeContract({
      address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'transfer',
      args: [to, amt], chain,
    });
    await pub.waitForTransactionReceipt({ hash });
    console.log(`[fund] ${role} +${formatUnits(amt, dec)} USDC  tx=${hash}`);
  } else {
    console.log(`[fund] ${role} USDC ok (${formatUnits(usdcBal, dec)})`);
  }
}

for (const t of TARGETS) await send(t.role, t.eth, t.usdc);
console.log('[fund] done');

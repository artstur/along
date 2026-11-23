// 每用户配对管理 CLI（docs/cloud-deploy-multi-user.md §3.2，M1；加固见 docs/cloud-security-hardening.md §3.1）：
//   node host/pair-code.mjs <userId>             为状态目录 users.json 里的用户生成 8 位一次性码
//                                                （15 分钟有效、单次有效），写入 pairing-codes.json（0600）
//   node host/pair-code.mjs --revoke <userId>   吊销该用户的配对绑定（下一个请求即 401，host 无需重启）
// 在云服务器上经 docker exec 运行，输出进管理员终端、不进容器日志（§3.7）；server 端每次调用重读
// 状态文件完成交接。没有清窗子命令：失败窗口按来源分桶后「发码清窗刷新攻击者配对额度」不复存在
// （攻击者只能烧自己的桶），同 IP 噪音最长 15 分钟自然过期（G-12/SD-H2）。
import {issuePairingCode, revokePairing, stateDir} from './pairing.mjs';

const [command,userId]=process.argv.slice(2);
try {
  if (command==='--revoke') {
    if (!userId) throw Error('用法：node host/pair-code.mjs --revoke <userId>');
    // 吊销同时清掉该用户的未消费配对码（设计 §6）：只删绑定表的话，
    // 吊销前发出的旧码仍然能换出新 token。
    if (!await revokePairing(stateDir(),userId)) throw Error(`没有用户 ${userId} 的配对绑定或未消费配对码`);
    console.log(`已吊销用户 ${userId} 的配对绑定与未消费配对码`);
  } else {
    if (!command) throw Error('用法：node host/pair-code.mjs <userId>（userId 须已在状态目录的 users.json 里）；吊销绑定用 --revoke <userId>');
    console.log(await issuePairingCode(stateDir(),command));
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

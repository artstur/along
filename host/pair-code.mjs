// 每用户一次性配对码 CLI（docs/cloud-deploy-multi-user.md §3.2，M1）：
//   node host/pair-code.mjs <userId>
// 为状态目录 users.json 里的用户生成 8 位一次性码（15 分钟有效、单次有效），写入
// pairing-codes.json（0600）。在云服务器上经 docker exec 运行，输出进管理员终端、
// 不进容器日志（§3.7）；server 端 /pair 每次调用重读该文件完成交接。
import {issuePairingCode, stateDir} from './pairing.mjs';

const userId=process.argv[2];
try {
  if (!userId) throw Error('用法：node host/pair-code.mjs <userId>（userId 须已在状态目录的 users.json 里）');
  console.log(await issuePairingCode(stateDir(),userId));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

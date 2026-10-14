// WSL localhost forwarding can occupy Windows IPv4 before Chrome starts, in
// which case Chrome binds IPv6. Prefer IPv6 and fall back to IPv4 when absent.
export function windowsPump(port, timeoutMs = 5000) {
  return `require("dns").setDefaultResultOrder("ipv6first");`
    + `const s=require("net").connect({port:${port},host:"localhost",autoSelectFamily:true});`
    + `const timer=setTimeout(()=>{console.error("Windows CDP handshake timed out");s.destroy();},${timeoutMs});`
    + `s.once("data",()=>clearTimeout(timer));`
    + `process.stdin.pipe(s);s.pipe(process.stdout);`
    + `process.stdin.on("end",()=>s.destroy());`
    + `s.on("close",()=>process.exit(0));s.on("error",e=>{console.error(e.message);process.exit(1)});`;
}

import init, * as bindings from './chat-sidebar-5d93542466ebbf58.js';
const wasm = await init({ module_or_path: './chat-sidebar-5d93542466ebbf58_bg.wasm' });


window.wasmBindings = bindings;


dispatchEvent(new CustomEvent("TrunkApplicationStarted", {detail: {wasm}}));
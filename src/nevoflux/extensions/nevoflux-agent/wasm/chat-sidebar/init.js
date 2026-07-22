import init, * as bindings from './chat-sidebar-15b15f14ef4d3ee5.js';
const wasm = await init({ module_or_path: './chat-sidebar-15b15f14ef4d3ee5_bg.wasm' });


window.wasmBindings = bindings;


dispatchEvent(new CustomEvent("TrunkApplicationStarted", {detail: {wasm}}));
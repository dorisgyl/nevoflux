import init, * as bindings from './chat-sidebar-e1ca053998a80af5.js';
const wasm = await init({ module_or_path: './chat-sidebar-e1ca053998a80af5_bg.wasm' });


window.wasmBindings = bindings;


dispatchEvent(new CustomEvent("TrunkApplicationStarted", {detail: {wasm}}));
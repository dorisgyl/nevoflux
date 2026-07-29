import init, * as bindings from './chat-sidebar-e66afe63fec72a92.js';
const wasm = await init({ module_or_path: './chat-sidebar-e66afe63fec72a92_bg.wasm' });


window.wasmBindings = bindings;


dispatchEvent(new CustomEvent("TrunkApplicationStarted", {detail: {wasm}}));
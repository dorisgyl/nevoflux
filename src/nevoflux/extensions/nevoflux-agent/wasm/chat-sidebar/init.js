import init, * as bindings from './chat-sidebar-66376e1e7638aac8.js';
const wasm = await init({ module_or_path: './chat-sidebar-66376e1e7638aac8_bg.wasm' });


window.wasmBindings = bindings;


dispatchEvent(new CustomEvent("TrunkApplicationStarted", {detail: {wasm}}));
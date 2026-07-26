import init, * as bindings from './chat-sidebar-9828a14f13b1fc70.js';
const wasm = await init({ module_or_path: './chat-sidebar-9828a14f13b1fc70_bg.wasm' });


window.wasmBindings = bindings;


dispatchEvent(new CustomEvent("TrunkApplicationStarted", {detail: {wasm}}));
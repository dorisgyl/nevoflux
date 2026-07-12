import init, * as bindings from './chat-sidebar-580a0e2188bdac8c.js';
const wasm = await init({ module_or_path: './chat-sidebar-580a0e2188bdac8c_bg.wasm' });


window.wasmBindings = bindings;


dispatchEvent(new CustomEvent("TrunkApplicationStarted", {detail: {wasm}}));
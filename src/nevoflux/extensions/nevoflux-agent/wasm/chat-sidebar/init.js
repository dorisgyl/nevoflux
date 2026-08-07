import init, * as bindings from './chat-sidebar-a49637e2efd000c7.js';
const wasm = await init({ module_or_path: './chat-sidebar-a49637e2efd000c7_bg.wasm' });


window.wasmBindings = bindings;


dispatchEvent(new CustomEvent("TrunkApplicationStarted", {detail: {wasm}}));
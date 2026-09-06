import init, * as bindings from './chat-sidebar-7df4644c4cb62e8e.js';
const wasm = await init({ module_or_path: './chat-sidebar-7df4644c4cb62e8e_bg.wasm' });


window.wasmBindings = bindings;


dispatchEvent(new CustomEvent("TrunkApplicationStarted", {detail: {wasm}}));
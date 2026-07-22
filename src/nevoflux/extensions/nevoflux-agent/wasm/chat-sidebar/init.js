import init, * as bindings from './chat-sidebar-93aa2f8038eaace5.js';
const wasm = await init({ module_or_path: './chat-sidebar-93aa2f8038eaace5_bg.wasm' });


window.wasmBindings = bindings;


dispatchEvent(new CustomEvent("TrunkApplicationStarted", {detail: {wasm}}));
import init, * as bindings from './chat-sidebar-e4d68775d49c156b.js';
const wasm = await init({ module_or_path: './chat-sidebar-e4d68775d49c156b_bg.wasm' });


window.wasmBindings = bindings;


dispatchEvent(new CustomEvent("TrunkApplicationStarted", {detail: {wasm}}));
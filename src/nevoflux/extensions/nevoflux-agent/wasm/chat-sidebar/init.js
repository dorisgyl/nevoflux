import init, * as bindings from './chat-sidebar-5363e676e179bc84.js';
const wasm = await init({ module_or_path: './chat-sidebar-5363e676e179bc84_bg.wasm' });


window.wasmBindings = bindings;


dispatchEvent(new CustomEvent("TrunkApplicationStarted", {detail: {wasm}}));
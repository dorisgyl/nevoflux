import init, * as bindings from './chat-sidebar-a00855828f277e00.js';
const wasm = await init({ module_or_path: './chat-sidebar-a00855828f277e00_bg.wasm' });


window.wasmBindings = bindings;


dispatchEvent(new CustomEvent("TrunkApplicationStarted", {detail: {wasm}}));
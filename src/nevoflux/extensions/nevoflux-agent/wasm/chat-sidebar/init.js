import init, * as bindings from './chat-sidebar-ca6b6df333ad8d61.js';
const wasm = await init({ module_or_path: './chat-sidebar-ca6b6df333ad8d61_bg.wasm' });


window.wasmBindings = bindings;


dispatchEvent(new CustomEvent("TrunkApplicationStarted", {detail: {wasm}}));
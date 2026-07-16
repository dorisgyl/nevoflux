import init, * as bindings from './chat-sidebar-6524309a62213d4d.js';
const wasm = await init({ module_or_path: './chat-sidebar-6524309a62213d4d_bg.wasm' });


window.wasmBindings = bindings;


dispatchEvent(new CustomEvent("TrunkApplicationStarted", {detail: {wasm}}));
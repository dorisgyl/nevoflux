import init, * as bindings from './chat-sidebar-4b498cef5d77f042.js';
const wasm = await init({ module_or_path: './chat-sidebar-4b498cef5d77f042_bg.wasm' });


window.wasmBindings = bindings;


dispatchEvent(new CustomEvent("TrunkApplicationStarted", {detail: {wasm}}));
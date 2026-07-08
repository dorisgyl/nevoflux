import init, * as bindings from './chat-sidebar-d637956c583c7e56.js';
const wasm = await init({ module_or_path: './chat-sidebar-d637956c583c7e56_bg.wasm' });


window.wasmBindings = bindings;


dispatchEvent(new CustomEvent("TrunkApplicationStarted", {detail: {wasm}}));
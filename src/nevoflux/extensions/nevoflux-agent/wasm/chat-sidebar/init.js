import init, * as bindings from './chat-sidebar-f6a162a15dae76af.js';
const wasm = await init({ module_or_path: './chat-sidebar-f6a162a15dae76af_bg.wasm' });


window.wasmBindings = bindings;


dispatchEvent(new CustomEvent("TrunkApplicationStarted", {detail: {wasm}}));
// Every test file runs device scripts as real Lua on MemoryKv.
import { installLua } from '../dev/lua-engine.ts';

installLua();

(() => {
    const codeEl = document.getElementById('code');
    const runBtn = document.getElementById('run');
    const consoleEl = document.getElementById('console');
    const consoleInput = document.getElementById('consoleInput');
    const clearConsoleBtn = document.getElementById('clearConsole');
    const debugOut = document.getElementById('debugOut');
    const showAstBtn = document.getElementById('showAst');

    // Runtime state
    let awaitingInputResolver = null;

    function appendConsole(text) {
        consoleEl.textContent += text;
        if (!text.endsWith('\n')) {
            consoleEl.textContent += '\n';
        }
        consoleEl.scrollTop = consoleEl.scrollHeight;
    }

    function addConsole(text) {
        consoleEl.textContent += text;
    }

    // --- LEXER helpers ---
    function splitLines(source) {
        return source.replace(/\r/g, '').split('\n');
    }

    function stripComment(line) {
        let inStr = false;
        let quote = null;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (!inStr && (ch === '"' || ch === "'")) {
                inStr = true;
                quote = ch;
                continue;
            }
            if (inStr && ch === quote) {
                inStr = false;
                quote = null;
                continue;
            }
            if (!inStr && ch === '/' && line[i + 1] === '/') {
                return line.slice(0, i);
            }
        }
        return line;
    }

    function tokenizeLine(line) {
        const tokens = [];
        let cur = '';
        let inStr = false;
        let quote = null;

        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (inStr) {
                cur += ch;
                if (ch === quote) {
                    tokens.push(cur);
                    cur = '';
                    inStr = false;
                    quote = null;
                }
            } else {
                if (ch === '"' || ch === "'") {
                    inStr = true;
                    quote = ch;
                    cur = ch;
                } else if (/\s/.test(ch)) {
                    if (cur) {
                        tokens.push(cur);
                        cur = '';
                    }
                } else if ([':', ',', '(', ')', '[', ']', '^'].includes(ch)) {
                    if (cur) {
                        tokens.push(cur);
                        cur = '';
                    }
                    tokens.push(ch);
                } else {
                    const two = line.slice(i, i + 2);
                    const op2 = ['<=', '>=', '<>', '<-', '**', '//'].includes(two);
                    if (op2) {
                        if (cur) {
                            tokens.push(cur);
                            cur = '';
                        }
                        tokens.push(two);
                        i++;
                    } else {
                        cur += ch;
                    }
                }
            }
        }
        if (cur) {
            tokens.push(cur);
        }
        return tokens;
    }

    // --- PARSER ---
    function parse(source) {
        const rawLines = splitLines(source);
        const lines = rawLines.map(l => stripComment(l)).map(l => l.trimEnd());
        const tokensByLine = lines.map(l => l.trim() === '' ? [] : tokenizeLine(l));
        let i = 0;

        const definitions = {
            types: {},
            functions: {},
            constants: new Set()
        };

        function parseBlock(endTokens) {
            const stmts = [];
            while (i < tokensByLine.length) {
                const tokens = tokensByLine[i].slice();
                const peek = tokens.join(' ').trim().toUpperCase();
                if (endTokens && endTokens.some(t => peek === t || peek.startsWith(t + ' '))) {
                    break;
                }
                const stmt = parseStatement();
                if (stmt) {
                    stmts.push(stmt);
                }
            }
            return stmts;
        }

        function parseStatement() {
            const tokens = tokensByLine[i];
            if (!tokens || tokens.length === 0) {
                i++;
                return null;
            }

            const tok0 = tokens[0].toUpperCase();

            if (tok0 === 'DECLARE') {
                const rest = tokens.slice(1);
                const colonIdx = rest.indexOf(':');
                if (colonIdx === -1) {
                    i++;
                    return { type: 'noop' };
                }
                const id = rest.slice(0, colonIdx).join('').trim();
                const typeTokens = rest.slice(colonIdx + 1);
                const t0 = (typeTokens[0] || '').toUpperCase();

                if (t0 === 'ARRAY') {
                    const bracketStart = typeTokens.indexOf('[');
                    const bracketEnd = typeTokens.indexOf(']');
                    const dimsSpec = typeTokens.slice(bracketStart + 1, bracketEnd).join('');
                    const dims = dimsSpec.split(',').map(s => {
                        const m = s.split(':').map(x => x.trim());
                        return {
                            lower: parseInt(m[0], 10),
                            upper: parseInt(m[1], 10)
                        };
                    });
                    const ofIdx = typeTokens.findIndex(t => t.toUpperCase() === 'OF');
                    const baseType = typeTokens.slice(ofIdx + 1).join('').trim();
                    i++;
                    return { type: 'declare_array', id, dims, baseType };
                } else {
                    const baseType = typeTokens.join('').trim();
                    i++;
                    return { type: 'declare', id, baseType };
                }
            }

            if (tok0 === 'CONSTANT') {
                const rest = tokens.slice(1);
                let id = rest[0];
                let assignIdx = rest.findIndex(t => t === '<-' || t === '=');
                if (assignIdx === -1) {
                    i++;
                    return { type: 'noop' };
                }
                const expr = rest.slice(assignIdx + 1).join(' ');
                i++;
                definitions.constants.add(id);
                return { type: 'constant', id, expr };
            }

            if (tok0 === 'TYPE') {
                const name = tokens[1];
                i++;
                const attrs = {};
                while (i < tokensByLine.length) {
                    const tline = tokensByLine[i];
                    if (!tline || tline.length === 0) {
                        i++;
                        continue;
                    }
                    if (tline[0].toUpperCase && tline[0].toUpperCase() === 'ENDTYPE') {
                        i++;
                        break;
                    }
                    const t0 = (tline[0] || '').toUpperCase();
                    if (t0 === 'DECLARE') {
                        const colon = tline.indexOf(':');
                        if (colon >= 0) {
                            const attr = tline.slice(1, colon).join('').trim();
                            const dtype = tline.slice(colon + 1).join('').trim();
                            attrs[attr] = dtype;
                        }
                    }
                    i++;
                }
                definitions.types[name] = { attrs };
                return { type: 'type_def', name, attrs };
            }

            if (tok0 === 'FUNCTION') {
                const name = tokens[1].split('(')[0];
                const fullLine = tokens.join(' ');
                const parenStart = fullLine.indexOf('(');
                const parenEnd = fullLine.indexOf(')');
                const paramStr = (parenStart >= 0 && parenEnd >= 0) ? fullLine.slice(parenStart + 1, parenEnd) : '';
                
                let currentPassMethod = false; 
                const params = [];
                for (let s of paramStr.split(',')) {
                    const t = s.trim();
                    if (!t) continue;
                    
                    let isRef = currentPassMethod;
                    let str = t;
                    const upperStr = str.toUpperCase();
                    
                    if (upperStr.startsWith('BYREF ')) {
                        isRef = true;
                        currentPassMethod = true;
                        str = str.substring(6).trim();
                    } else if (upperStr.startsWith('BYVAL ')) {
                        isRef = false;
                        currentPassMethod = false;
                        str = str.substring(6).trim();
                    } else if (str.startsWith('^')) {
                        isRef = true;
                        str = str.substring(1).trim();
                    }
                    
                    const pr = str.split(':').map(x => x.trim());
                    let pName = pr[0];
                    if (pName.startsWith('^')) {
                        isRef = true;
                        pName = pName.substring(1).trim();
                    }
                    params.push({ name: pName, type: pr[1] || null, byref: isRef });
                }

                const up = fullLine.toUpperCase();
                const rIdx = up.indexOf('RETURNS');
                const returnsType = rIdx >= 0 ? fullLine.slice(rIdx + 7).trim() : null;

                i++;
                const body = parseBlock(['ENDFUNCTION']);
                if (i < tokensByLine.length && tokensByLine[i]?.[0]?.toUpperCase() === 'ENDFUNCTION') {
                    i++;
                }
                definitions.functions[name] = { type: 'function', name, params, returnsType, body };
                return { type: 'function_def', name, params, returnsType, body };
            }

            if (tok0 === 'PROCEDURE') {
                const full = tokens.join(' ');
                const name = tokens[1].split('(')[0];
                const parenStart = full.indexOf('(');
                const parenEnd = full.indexOf(')');
                const paramStr = (parenStart >= 0 && parenEnd >= 0) ? full.slice(parenStart + 1, parenEnd) : '';
                
                let currentPassMethod = false; 
                const params = [];
                for (let s of paramStr.split(',')) {
                    const t = s.trim();
                    if (!t) continue;
                    
                    let isRef = currentPassMethod;
                    let str = t;
                    const upperStr = str.toUpperCase();
                    
                    if (upperStr.startsWith('BYREF ')) {
                        isRef = true;
                        currentPassMethod = true;
                        str = str.substring(6).trim();
                    } else if (upperStr.startsWith('BYVAL ')) {
                        isRef = false;
                        currentPassMethod = false;
                        str = str.substring(6).trim();
                    } else if (str.startsWith('^')) {
                        isRef = true;
                        str = str.substring(1).trim();
                    }
                    
                    const pr = str.split(':').map(x => x.trim());
                    let pName = pr[0];
                    if (pName.startsWith('^')) {
                        isRef = true;
                        pName = pName.substring(1).trim();
                    }
                    params.push({ name: pName, type: pr[1] || null, byref: isRef });
                }

                i++;
                const body = parseBlock(['ENDPROCEDURE']);
                if (i < tokensByLine.length && tokensByLine[i]?.[0]?.toUpperCase() === 'ENDPROCEDURE') {
                    i++;
                }
                definitions.functions[name] = { type: 'procedure', name, params, body };
                return { type: 'proc_def', name, params, body };
            }

            if (tok0 === 'IF') {
                const line = tokens.join(' ');
                const cond = line.replace(/^IF\s+/i, '').replace(/\s+THEN\s*$/i, '').trim();
                i++;
                const cases = [];
                const ifBody = parseBlock(['ELSE', 'ENDIF']);
                cases.push({ cond, body: ifBody });

                while (i < tokensByLine.length) {
                    const tline = tokensByLine[i];
                    if (!tline || tline.length === 0) {
                        i++;
                        continue;
                    }
                    const head = (tline[0] || '').toUpperCase();
                    if (head === 'ELSE' && tline.length === 1) {
                        i++;
                        const elseBody = parseBlock(['ENDIF']);
                        if (i < tokensByLine.length && tokensByLine[i]?.[0]?.toUpperCase() === 'ENDIF') {
                            i++;
                        }
                        return { type: 'if', cases, elseBody };
                    } else if (head === 'ELSE' && (tline[1] || '').toUpperCase() === 'IF') {
                        const full = tline.join(' ');
                        const m = full.match(/ELSE\s+IF\s+(.*?)\s+THEN/i);
                        if (m) {
                            const cond2 = m[1].trim();
                            i++;
                            const body2 = parseBlock(['ELSE', 'ENDIF']);
                            cases.push({ cond: cond2, body: body2 });
                            continue;
                        }
                    } else if (head === 'ENDIF') {
                        i++;
                        return { type: 'if', cases, elseBody: null };
                    } else {
                        break;
                    }
                }
                return { type: 'if', cases, elseBody: null };
            }

            if (tok0 === 'WHILE') {
                const full = tokens.join(' ');
                const m = full.match(/^WHILE\s+(.*)\s+DO$/i);
                const cond = m ? m[1].trim() : full.replace(/^WHILE/i, '').replace(/DO$/i, '').trim();
                i++;
                const body = parseBlock(['ENDWHILE']);
                if (i < tokensByLine.length && tokensByLine[i]?.[0]?.toUpperCase() === 'ENDWHILE') {
                    i++;
                }
                return { type: 'while', condition: cond, body };
            }

            if (tok0 === 'REPEAT') {
                i++;
                const body = parseBlock(['UNTIL']);
                if (i < tokensByLine.length) {
                    const untilLine = tokensByLine[i].join(' ').trim();
                    const m = untilLine.match(/^UNTIL\s+(.*)$/i);
                    let cond = m ? m[1].trim() : null;
                    i++;
                    return { type: 'repeat', body, until: cond };
                }
                return { type: 'repeat', body, until: null };
            }

            if (tok0 === 'FOR') {
                const full = tokens.join(' ');
                const m = full.match(/^FOR\s+([A-Za-z_]\w*)\s*(?:<-|=)\s*(.*?)\s+TO\s+(.*)$/i);
                if (!m) {
                    i++;
                    return { type: 'noop' };
                }
                const v = m[1];
                const start = m[2].trim();
                const end = m[3].trim();
                i++;
                const body = parseBlock(['NEXT']);
                if (i < tokensByLine.length && tokensByLine[i]?.[0]?.toUpperCase() === 'NEXT') {
                    i++;
                }
                return { type: 'for', var: v, start, end, body };
            }

            if (tok0 === 'CASE') {
                const full = tokensByLine[i].join(' ');
                const m = full.match(/^CASE\s+OF\s+(.*)$/i);
                const expr = m ? m[1].trim() : null;
                i++;
                const branches = [];
                let otherwise = null;
                while (i < tokensByLine.length) {
                    const tline = tokensByLine[i];
                    if (!tline || tline.length === 0) {
                        i++;
                        continue;
                    }
                    const first = (tline[0] || '').toUpperCase();
                    if (first === 'ENDCASE') {
                        i++;
                        break;
                    }
                    const joined = tline.join(' ');
                    const colonIdx = joined.indexOf(':');
                    if (colonIdx > -1) {
                        const left = joined.slice(0, colonIdx).trim();
                        const right = joined.slice(colonIdx + 1).trim();
                        if (left.toUpperCase() === 'OTHERWISE') {
                            otherwise = [parseInlineStatementFromString(right)];
                        } else if (left.toUpperCase().includes('TO')) {
                            const [lo, hi] = left.split(/TO/i).map(s => s.trim());
                            branches.push({ type: 'range', lo, hi, stmt: parseInlineStatementFromString(right) });
                        } else {
                            branches.push({ type: 'value', val: left, stmt: parseInlineStatementFromString(right) });
                        }
                        i++;
                        continue;
                    }
                    i++;
                }
                return { type: 'case', expr, branches, otherwise };
            }

            if (tok0 === 'CALL') {
                const rest = tokens.slice(1).join(' ');
                i++;
                return { type: 'call', call: rest };
            }

            if (tok0 === 'OUTPUT') {
                const expr = tokens.slice(1).join(' ');
                i++;
                return { type: 'output', expr };
            }

            if (tok0 === 'INPUT') {
                const id = tokens.slice(1).join(''); 
                i++;
                return { type: 'input', id };
            }

            const arrowIdx = tokens.indexOf('<-');
            if (arrowIdx >= 0) {
                const left = tokens.slice(0, arrowIdx).join('');
                let rightTokens = tokens.slice(arrowIdx + 1);
                let isRefAssign = false;
                if (rightTokens.length > 0 && rightTokens[0] === '^') {
                    isRefAssign = true;
                    rightTokens.shift();
                }
                const expr = rightTokens.join(' ');
                i++;
                return { type: 'assign', left, expr, isRefAssign };
            }

            if (tok0 === 'RETURN') {
                const expr = tokens.slice(1).join(' ');
                i++;
                return { type: 'return', expr };
            }

            const fallbackExpr = tokens.join(' ');
            i++;
            return { type: 'expr', expr: fallbackExpr };
        }

        function parseInlineStatementFromString(str) {
            const tokens = tokenizeLine(str);
            if (!tokens || tokens.length === 0) return { type: 'noop' };
            const first = (tokens[0] || '').toUpperCase();
            if (first === 'OUTPUT') return { type: 'output', expr: tokens.slice(1).join(' ') };
            if (first === 'CALL') return { type: 'call', call: tokens.slice(1).join(' ') };
            if (first === 'INPUT') return { type: 'input', id: tokens[1] };

            const arrowIdx = tokens.indexOf('<-');
            const eqIdx = tokens.indexOf('=');
            if (arrowIdx >= 0 || eqIdx >= 0) {
                const idx = arrowIdx >= 0 ? arrowIdx : eqIdx;
                const left = tokens.slice(0, idx).join('');
                let rightTokens = tokens.slice(idx + 1);
                let isRefAssign = false;
                if (rightTokens.length > 0 && rightTokens[0] === '^') {
                    isRefAssign = true;
                    rightTokens.shift();
                }
                const expr = rightTokens.join(' ');
                return { type: 'assign', left, expr, isRefAssign };
            }
            return { type: 'expr', expr: str };
        }

        const program = parseBlock();
        return { program, definitions };
    }

    // --- RUNTIME ---
    function makeArray(dims) {
        function build(dimIndex) {
            const d = dims[dimIndex];
            const len = d.upper - d.lower + 1;
            const arr = new Array(len).fill(undefined);
            if (dimIndex === dims.length - 1) return arr;
            for (let i = 0; i < len; i++) {
                arr[i] = build(dimIndex + 1);
            }
            return arr;
        }
        const root = build(0);

        function wrap(obj, dimIndex) {
            if (!Array.isArray(obj)) return obj;
            const lower = dims[dimIndex].lower;
            return new Proxy(obj, {
                get(target, prop) {
                    if (prop === '__isArray') return true;
                    if (prop === '__lower') return lower;
                    if (typeof prop === 'string' && /^-?\d+$/.test(prop)) {
                        return target[parseInt(prop, 10) - lower];
                    }
                    return target[prop];
                },
                set(target, prop, value) {
                    if (typeof prop === 'string' && /^-?\d+$/.test(prop)) {
                        target[parseInt(prop, 10) - lower] = value;
                        return true;
                    }
                    target[prop] = value;
                    return true;
                }
            });
        }

        function wrapRec(obj, idx) {
            if (!Array.isArray(obj)) return obj;
            const w = wrap(obj, idx);
            for (let i = 0; i < obj.length; i++) {
                if (Array.isArray(obj[i])) {
                    obj[i] = wrapRec(obj[i], idx + 1);
                }
            }
            return w;
        }
        return wrapRec(root, 0);
    }

    function createExecutor() {
        const vars = {};
        const constants = new Set();
        const functions = {};

        const builtins = {
            STR: x => String(x),
            NUM: x => (typeof x === 'boolean' ? (x ? 1 : 0) : Number(x)),
            BOOL: x => Boolean(x),
            LEFT: (s, n) => String(s).slice(0, Number(n)),
            RIGHT: (s, n) => {
                const str = String(s);
                return str.slice(Math.max(0, str.length - Number(n)));
            },
            MID: (s, p, len) => String(s).substr(Number(p) - 1, Number(len)),
            SUBSTRING: (s, p, len) => String(s).substr(Number(p) - 1, Number(len)),
            LENGTH: s => String(s).length,
            UCASE: s => String(s).toUpperCase(),
            LCASE: s => String(s).toLowerCase(),
            RANDOM: () => Math.random(),
            RAND: x => x * Math.random(),
            ROUND: (n, p) => {
                if (p === undefined) return Math.round(Number(n));
                const pow = Math.pow(10, Number(p));
                return Math.round(Number(n) * pow) / pow;
            },
            INT: x => Math.floor(x)
        };

        function isRefVal(v) {
            return v && typeof v === 'object' && v.__isRef === true;
        }

        function getVar(name) {
            if (!(name in vars)) return undefined;
            const v = vars[name];
            if (isRefVal(v)) return v.get(); 
            return v;
        }

        function setVar(name, value) {
            if (constants.has(name)) throw new Error('Cannot modify constant ' + name);
            if (name in vars && isRefVal(vars[name])) {
                vars[name].set(value); 
                return;
            }
            vars[name] = value;
        }

        function createRef(expr, localBindings) {
            return {
                __isRef: true,
                get: async () => await evalExpr(expr, localBindings),
                set: async (val) => await setLValue(expr, val, localBindings)
            };
        }

        function buildScope(localBindings = {}) {
            const scope = {};
            const allKeys = new Set([...Object.keys(vars), ...Object.keys(localBindings), ...Object.keys(builtins)]);

            allKeys.forEach(k => {
                if (builtins[k]) {
                    scope[k] = builtins[k];
                } else {
                    Object.defineProperty(scope, k, {
                        configurable: true,
                        enumerable: true,
                        get() {
                            if (k in localBindings) {
                                const v = localBindings[k];
                                if (v && v.__isRef) return v.get(); 
                                return v;
                            }
                            return getVar(k);
                        },
                        set(v) {
                            if (k in localBindings) {
                                const cur = localBindings[k];
                                if (cur && cur.__isRef) return cur.set(v); 
                                localBindings[k] = v;
                                return;
                            }
                            setVar(k, v);
                        }
                    });
                }
            });

            scope.__runtime_call = async (name, ...args) => {
                const resolved = await Promise.all(args);
                return await callUserFunction(name, resolved);
            };
            return scope;
        }

        function transformExpression(expr) {
            if (!expr || expr.trim() === '') return 'undefined';

            let res = '';
            let bracketDepth = 0;
            let parenDepth = 0;

            for (let i = 0; i < expr.length; ) {
                const ch = expr[i];

                if (ch === '"' || ch === "'") {
                    const quote = ch;
                    res += ch; i++;
                    while (i < expr.length && expr[i] !== quote) {
                        res += expr[i]; i++;
                    }
                    if (i < expr.length) { res += expr[i]; i++; }
                    continue;
                }

                if (/[A-Za-z_]/.test(ch)) {
                    let j = i + 1;
                    while (j < expr.length && /[A-Za-z0-9_]/.test(expr[j])) j++;
                    const ident = expr.slice(i, j);
                    const upper = ident.toUpperCase();

                    const keywords = {
                        'AND': '&&', 'OR': '||', 'NOT': '!', 
                        'TRUE': 'true', 'FALSE': 'false', 'MOD': '%', 'DIV': '/'
                    };

                    if (keywords[upper]) {
                        res += keywords[upper];
                        i = j;
                    } else {
                        let k = j;
                        while (k < expr.length && /\s/.test(expr[k])) k++;
                        if (k < expr.length && expr[k] === '(' && functions.hasOwnProperty(ident)) {
                            let p = k + 1, depth = 1;
                            while (p < expr.length && depth > 0) {
                                if (expr[p] === '(') depth++;
                                else if (expr[p] === ')') depth--;
                                p++;
                            }
                            const argsInside = expr.slice(k + 1, p - 1);
                            res += `await __runtime_call("${ident}", ${transformExpression(argsInside)})`;
                            i = p;
                        } else {
                            res += ident;
                            i = j;
                        }
                    }
                } 
                else {
                    const two = expr.slice(i, i + 2);
                    if (two === '<>') { res += '!=='; i += 2; }
                    else if (two === '<=') { res += '<='; i += 2; }
                    else if (two === '>=') { res += '>='; i += 2; }
                    else if (ch === '=') { 
                        res += '==='; 
                        i++; 
                    } 
                    else if (ch === '[') {
                        bracketDepth++;
                        res += ch; i++;
                    }
                    else if (ch === ']') {
                        bracketDepth--;
                        res += ch; i++;
                    }
                    else if (ch === '(') {
                        parenDepth++;
                        res += ch; i++;
                    }
                    else if (ch === ')') {
                        parenDepth--;
                        res += ch; i++;
                    }
                    else if (ch === ',' && bracketDepth > 0 && parenDepth === 0) {
                        res += '][';
                        i++;
                    }
                    else { res += ch; i++; }
                }
            }
            return res;
        }

        async function evalExpr(expr, localBindings = {}) {
            const jsExpr = transformExpression(expr);
            const scope = buildScope(localBindings);
            try {
                const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
                const fn = new AsyncFunction('scope', `with(scope) { return (${jsExpr}); }`);
                return await fn(scope);
            } catch (e) {
                const trim = expr.trim();
                if (/^".*"$/.test(trim) || /^'.*'$/.test(trim)) return trim.slice(1, -1);
                if (/^-?\d+(\.\d+)?$/.test(trim)) return Number(trim);
                if (/^[A-Za-z_]\w*$/.test(trim)) return getVar(trim);
                throw e;
            }
        }

        async function setLValue(leftStr, value, localBindings = {}) {
            const scope = buildScope(localBindings);
            const jsExpr = transformExpression(leftStr);
            const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
            const fn = new AsyncFunction('scope', '__val', `with(scope) { ${jsExpr} = __val; }`);
            await fn(scope, value);
        }

        async function execBlock(nodes, localBindings = {}) {
            for (let node of nodes) {
                const res = await execNode(node, localBindings);
                if (res && res.__returned) return res;
            }
            return null;
        }

        async function callUserFunction(name, argValues) {
            const fnDef = functions[name];
            if (!fnDef) throw new Error('Function not found: ' + name);
            const callLocal = {};
            (fnDef.params || []).forEach((p, idx) => {
                if (p) callLocal[p.name] = argValues[idx];
            });
            const r = await execBlock(fnDef.body, callLocal);
            return r && r.__returned ? r.value : undefined;
        }

        async function execNode(node, localBindings = {}) {
            if (!node) return null;
            switch (node.type) {
                case 'noop':
                    return null;
                case 'declare':
                    vars[node.id] = undefined;
                    return null;
                case 'declare_array':
                    vars[node.id] = makeArray(node.dims);
                    return null;
                case 'constant':
                    vars[node.id] = await evalExpr(node.expr, localBindings);
                    constants.add(node.id);
                    return null;
                case 'function_def':
                case 'proc_def':
                    functions[node.name] = node;
                    return null;
                case 'output': {
                    const parts = splitTopLevel(node.expr, ',');
                    const results = [];
                    for (let p of parts) {
                        results.push(await evalExpr(p, localBindings));
                    }
                    appendConsole(results.join(''));
                    return null;
                }
                case 'input': {
                    const targets = splitTopLevel(node.id, ','); 
                    const showPrompts = document.getElementById('showPrompts').checked;

                    for (let target of targets) {
                        let trimmed = target.trim();
                        if (!trimmed) continue;

                        let displayId = trimmed;
                        const bracketMatch = trimmed.match(/^([A-Za-z_]\w*)\s*\[(.*)\]$/);
                        if (bracketMatch) {
                            const indices = splitTopLevel(bracketMatch[2], ',');
                            const evaled = [];
                            for (let ie of indices) evaled.push(await evalExpr(ie, localBindings));
                            displayId = `${bracketMatch[1]}[${evaled.join(',')}]`;
                        }

                        if (showPrompts) {
                            addConsole(`>> awaiting input for ${displayId}... `);
                        }

                        const val = await getConsoleInput();
                        const num = Number(val);
                        const finalVal = val.trim() === '' ? '' : (isNaN(num) ? val : num);
                        await setLValue(trimmed, finalVal, localBindings);
                        appendConsole(val);
                    }
                    return null;
                }
                case 'assign': {
                    if (node.isRefAssign) {
                        const refObj = createRef(node.expr, localBindings);
                        if (node.left in localBindings) {
                            localBindings[node.left] = refObj;
                        } else {
                            vars[node.left] = refObj;
                        }
                        return null;
                    }
                    const val = await evalExpr(node.expr, localBindings);
                    await setLValue(node.left, val, localBindings);
                    return null;
                }
                case 'return':
                    return { __returned: true, value: await evalExpr(node.expr, localBindings) };
                case 'if': {
                    for (let c of node.cases) {
                        if (await evalExpr(c.cond, localBindings)) {
                            return await execBlock(c.body, localBindings);
                        }
                    }
                    if (node.elseBody) return await execBlock(node.elseBody, localBindings);
                    return null;
                }
                case 'case': {
                    const val = await evalExpr(node.expr, localBindings);
                    let matched = false;
                    for (let b of node.branches) {
                        if (b.type === 'range') {
                            const lo = await evalExpr(b.lo, localBindings);
                            const hi = await evalExpr(b.hi, localBindings);
                            if (val >= lo && val <= hi) {
                                const res = await execNode(b.stmt, localBindings);
                                if (res && res.__returned) return res;
                                matched = true;
                                break;
                            }
                        } else {
                            const v = await evalExpr(b.val, localBindings);
                            if (val === v) {
                                const res = await execNode(b.stmt, localBindings);
                                if (res && res.__returned) return res;
                                matched = true;
                                break;
                            }
                        }
                    }
                    if (!matched && node.otherwise) {
                        return await execBlock(node.otherwise, localBindings);
                    }
                    return null;
                }
                case 'while':
                    while (await evalExpr(node.condition, localBindings)) {
                        const r = await execBlock(node.body, localBindings);
                        if (r && r.__returned) return r;
                    }
                    return null;
                case 'repeat': {
                    do {
                        const r = await execBlock(node.body, localBindings);
                        if (r && r.__returned) return r;
                    } while (!(await evalExpr(node.until, localBindings)));
                    return null;
                }
                case 'for': {
                    let cur = await evalExpr(node.start, localBindings);
                    const end = await evalExpr(node.end, localBindings);
                    setVar(node.var, cur);
                    while (getVar(node.var) <= end) {
                        const r = await execBlock(node.body, localBindings);
                        if (r && r.__returned) return r;
                        setVar(node.var, getVar(node.var) + 1);
                    }
                    return null;
                }
                case 'call': {
                    const m = node.call.trim().match(/^([A-Za-z_]\w*)\s*\((.*)\)$/) || node.call.trim().match(/^([A-Za-z_]\w*)\s+(.*)$/);
                    if (!m) throw new Error('Invalid CALL');
                    const name = m[1], argExprs = splitTopLevel(m[2] || '', ',').map(s => s.trim());
                    const fnDef = functions[name];
                    if (!fnDef) throw new Error('Procedure not found: ' + name);

                    const argValues = [];
                    for (let idx = 0; idx < argExprs.length; idx++) {
                        const pDef = fnDef.params[idx];
                        let aExpr = argExprs[idx];
                        
                        if (aExpr.startsWith('^')) {
                            aExpr = aExpr.substring(1).trim();
                        }
                        
                        if (pDef && pDef.byref) {
                            argValues.push(createRef(aExpr, localBindings));
                        } else {
                            argValues.push(await evalExpr(aExpr, localBindings));
                        }
                    }
                    await callUserFunction(name, argValues);
                    return null;
                }
            }
            return null;
        }

        return {
            vars, constants, functions,
            execProgram: async (prog) => {
                for (let node of prog) {
                    await execNode(node);
                }
            }
        };
    }

    function splitTopLevel(s, sep = ',') {
        const parts = [];
        let cur = '', depth = 0, inStr = false, quote = null;
        for (let ch of s) {
            if (inStr) {
                cur += ch;
                if (ch === quote) inStr = false;
            } else if (ch === '"' || ch === "'") {
                inStr = true;
                quote = ch;
                cur += ch;
            } else if (['(', '[', '{'].includes(ch)) {
                depth++;
                cur += ch;
            } else if ([')', ']', '}'].includes(ch)) {
                depth--;
                cur += ch;
            } else if (ch === sep && depth === 0) {
                parts.push(cur);
                cur = '';
            } else {
                cur += ch;
            }
        }
        if (cur !== '') parts.push(cur);
        return parts;
    }

    function getConsoleInput() {
        return new Promise(resolve => {
            awaitingInputResolver = resolve;
            consoleInput.focus();
        });
    }

    // Event Listeners
    consoleInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const v = consoleInput.value;
            consoleInput.value = '';
            if (awaitingInputResolver) {
                const res = awaitingInputResolver;
                awaitingInputResolver = null;
                res(v);
            }
        }
    });

    runBtn.addEventListener('click', async () => {
        consoleEl.textContent = '';
        debugOut.textContent = 'Executing...';
        try {
            const parsed = parse(codeEl.value);
            const ex = createExecutor();
            await ex.execProgram(parsed.program);
            debugOut.textContent = 'Finished.';
        } catch (e) {
            appendConsole('Error: ' + e.message);
        }
    });

    showAstBtn.addEventListener('click', () => {
        try {
            const parsed = parse(codeEl.value);
            debugOut.textContent = JSON.stringify(parsed, null, 4);
        } catch (e) {
            debugOut.textContent = e.message;
        }
    });

    clearConsoleBtn.addEventListener('click', () => {
        consoleEl.textContent = '';
    });
})();
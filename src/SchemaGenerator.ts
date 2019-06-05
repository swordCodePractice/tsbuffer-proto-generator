import { TSBufferSchema } from 'tsbuffer-schema';
import * as fs from "fs";
import * as path from "path";
import { AstParser } from './AstParser';
import { AstParserResult } from './AstParser';
import { SchemaUtil } from './SchemaUtil';
import { EncodeIdUtil } from './EncodeIdUtil';
import { InterfaceTypeSchema } from 'tsbuffer-schema/src/schemas/InterfaceTypeSchema';
import { IntersectionTypeSchema } from 'tsbuffer-schema/src/schemas/IntersectionTypeSchema';
import { UnionTypeSchema } from 'tsbuffer-schema/src/schemas/UnionTypeSchema';
import { ArrayTypeSchema } from 'tsbuffer-schema/src/schemas/ArrayTypeSchema';
import { IndexedAccessTypeSchema } from 'tsbuffer-schema/src/schemas/IndexedAccessTypeSchema';
import { TupleTypeSchema } from 'tsbuffer-schema/src/schemas/TupleTypeSchema';

export interface SchemaGeneratorOptions {
    /** Schema的根目录（路径在根目录以前的字符串会被相对掉） */
    baseDir: string;

    /** console.debug 打印调试信息 */
    verbose: boolean;

    /** 
     * 读取文件的方法（用于扩展自定义文件系统）
     * @param path 于baseDir的相对路径
     */
    readFile: (path: string) => Promise<string> | string;

    /**
     * 解析Module的路径
     * @param importPath 例如 import xx from 'abcd/efg' 则 importPath 为 'abcd/efg'
import SchemaUtil from './SchemaUtil';
     * @return 返回于baseDir的相对路径
     */
    resolveModule?: (importPath: string, baseDir: string) => string;
}

export class SchemaGenerator {

    protected readonly options: SchemaGeneratorOptions = {
        baseDir: '.',
        verbose: false,
        readFile: (v => fs.readFileSync(path.resolve(this.options.baseDir, v)).toString()),
        /** 默认将module解析为baseDir下的node_modules */
        resolveModule: (importPath: string) => path.join('node_modules', importPath)
    };

    constructor(options: Partial<SchemaGeneratorOptions> = {}) {
        Object.assign(this.options, options);
    }

    /**
     * 生成FileSchema
     * 对modules（例如node_modules）的引用，也会全部转为相对路径引用
     * @param paths 于baseDir的相对路径
     * @param options 
     */
    async generate(paths: string | string[], options: GenerateFileSchemaOptions = {}): Promise<GenerateResult> {
        let output: GenerateResult = {};

        if (typeof paths === 'string') {
            paths = [paths];
        }

        // 确保路径安全，再次将paths转为相对路径
        paths = paths.map(v => path.relative(this.options.baseDir, path.resolve(this.options.baseDir, v)));

        if (this.options.verbose) {
            console.debug('[TSBuffer Schema Generator]', 'generate', `Ready to generate ${paths.length} file`);
            console.debug('[TSBuffer Schema Generator]', 'generate', 'BaseDir=' + this.options.baseDir);
        }

        // AST CACHE
        let astCache: AstCache = {};

        // 默认filter是导出所有export项
        let filter = options.filter || (v => v.isExport);
        // 是要被导出的直接引用的项目
        let exports: { [path: string]: string[] } = {};

        // 生成这几个文件的AST CACHE
        for (let filepath of paths) {
            if (this.options.verbose) {
                console.debug('[TSBuffer Schema Generator]', 'generate', 'FilePath=' + filepath)
            }

            // 生成该文件的AST
            let { ast, astKey } = await this._getAst(filepath, astCache);

            if (this.options.verbose) {
                console.debug('[TSBuffer Schema Generator]', 'generate', 'AstLoaded Key=' + astKey);
            }

            // Filter出要被导出的
            for (let name in ast) {
                if (filter({
                    path: filepath,
                    name: name,
                    isExport: ast[name].isExport
                })) {
                    if (this.options.verbose) {
                        console.debug('[TSBuffer Schema Generator]', 'generate', `filter passed: ${name} at ${filepath}`);
                    }

                    // 记入exports
                    if (!exports[filepath]) {
                        exports[filepath] = [];
                    }
                    exports[filepath].push(name);

                    // 加入output
                    await this._addToOutput(astKey, name, ast[name].schema, output, astCache);
                }
                else if (this.options.verbose) {
                    console.debug('[TSBuffer Schema Generator]', 'generate', `filter not passed: ${name} at ${filepath}`);
                }
            }
        }

        // flatten

        // 重新生成EncodeId
        this._regenResultEncodeIds(output, options.compatibleResult);

        return output;
    }

    /**
     * 重新生成EncodeId
     * @param output 
     * @param compatibleResult 
     */
    private _regenResultEncodeIds(output: GenerateResult, compatibleResult?: GenerateResult) {
        for (let pathKey in output) {
            for (let name in output[pathKey]) {
                this._regenSchemaEncodeIds(
                    output[pathKey][name],
                    compatibleResult && compatibleResult[pathKey] && compatibleResult[pathKey][name]
                );
            }
        }
    }

    private _regenSchemaEncodeIds(schema: TSBufferSchema, compatibleSchema?: TSBufferSchema) {
        // 不仅要有 还要是同类型才行
        if (compatibleSchema && compatibleSchema.type !== schema.type) {
            compatibleSchema = undefined;
        }

        switch (schema.type) {
            case 'Enum': {
                let cpIds = EncodeIdUtil.getSchemaEncodeIds(compatibleSchema);
                let ids = EncodeIdUtil.genEncodeIds(EncodeIdUtil.getSchemaEncodeKeys(schema), cpIds);
                for (let i = 0; i < ids.length; ++i) {
                    schema.members[i].id = ids[i].id;
                }
                break;
            }
            case 'Interface': {
                // extends
                if (schema.extends) {
                    let cpExtends = compatibleSchema && (compatibleSchema as InterfaceTypeSchema).extends;
                    let cpIds = cpExtends && cpExtends.map(v => ({
                        key: JSON.stringify(v.type),
                        id: v.id
                    }));
                    let ids = EncodeIdUtil.genEncodeIds(schema.extends.map(v => JSON.stringify(v.type)), cpIds);
                    for (let i = 0; i < ids.length; ++i) {
                        schema.extends[i].id = ids[i].id;
                    }
                }

                // properties
                if (schema.properties) {
                    let cpIds = EncodeIdUtil.getSchemaEncodeIds(compatibleSchema);
                    let ids = EncodeIdUtil.genEncodeIds(EncodeIdUtil.getSchemaEncodeKeys(schema), cpIds);

                    let cpSchemaProps = compatibleSchema && (compatibleSchema as InterfaceTypeSchema).properties;
                    for (let i = 0; i < ids.length; ++i) {
                        // 更新ID
                        schema.properties[i].id = ids[i].id;
                        // 递归子项
                        let subCpProp = cpSchemaProps && cpSchemaProps.find(v => v.name === schema.properties![i].name);
                        this._regenSchemaEncodeIds(schema.properties[i].type, subCpProp ? subCpProp.type : undefined)
                    }
                }

                // indexSignature
                if (schema.indexSignature) {
                    let cpIndexSignature = compatibleSchema
                        && (compatibleSchema as InterfaceTypeSchema).indexSignature
                        && (compatibleSchema as InterfaceTypeSchema).indexSignature!.type || undefined;
                    this._regenSchemaEncodeIds(schema.indexSignature.type, cpIndexSignature);
                }

                break;
            }
            case 'Intersection':
            case 'Union':
                let cpIds = EncodeIdUtil.getSchemaEncodeIds(compatibleSchema);
                let ids = EncodeIdUtil.genEncodeIds(EncodeIdUtil.getSchemaEncodeKeys(schema), cpIds);
                for (let i = 0; i < ids.length; ++i) {
                    schema.members[i].id = ids[i].id;
                    // 递归子项
                    let subCpMember = compatibleSchema
                        && (compatibleSchema as IntersectionTypeSchema | UnionTypeSchema).members.find(v => v.id === ids[i].id);
                    let subCpSchema = subCpMember && subCpMember.type;
                    this._regenSchemaEncodeIds(schema.members[i].type, subCpSchema);
                }
                break;
            case 'Array':
                // TODO elementType
                this._regenSchemaEncodeIds(schema.elementType, compatibleSchema && (compatibleSchema as ArrayTypeSchema).elementType)
                break;
            case 'IndexedAccess':
                this._regenSchemaEncodeIds(schema.objectType, compatibleSchema && (compatibleSchema as IndexedAccessTypeSchema).objectType)
                break;
            case 'Tuple':
                for (let i = 0; i < schema.elementTypes.length; ++i) {
                    this._regenSchemaEncodeIds(schema.elementTypes[i], compatibleSchema && (compatibleSchema as TupleTypeSchema).elementTypes[i])
                }
                break;
        }
    }

    private async _getAst(pathOrKey: string, astCache: AstCache) {
        // GET AST KEY
        let astKey = pathOrKey.replace(/\\/g, '/').replace(/\.ts$/, '');

        if (!astCache[astKey]) {
            // 按node规则解析文件
            let fileContent: string | undefined;
            let postfixs = ['.ts', '.d.ts', '/index.ts', '/index.d.ts'];
            for (let postfix of postfixs) {
                try {
                    fileContent = await this.options.readFile(astKey + postfix);
                }
                // 出错 继续加载下一个
                catch{
                    continue;
                }
                // 未出错 说明解析到文件
                if (postfix.startsWith('/')) {
                    astKey = astKey + '/index';
                }
                break;
            }
            // 找不到文件，报错
            if (!fileContent) {
                throw new Error(`Cannot resolve file: ` + path.resolve(this.options.baseDir, astKey))
            }

            astCache[astKey] = AstParser.parseScript(fileContent);
        }
        return {
            ast: astCache[astKey],
            astKey: astKey
        };
    }

    private async _addToOutput(astKey: string, name: string, schema: TSBufferSchema, output: GenerateResult, astCache: AstCache) {
        if (this.options.verbose) {
            console.debug('[TSBuffer Schema Generator]', `addToOutput(${astKey}, ${name}})`)
        }

        if (!output[astKey]) {
            output[astKey] = {};
        }

        if (!output[astKey][name]) {
            output[astKey][name] = schema;

            // 递归加入引用
            let refs = SchemaUtil.getUsedReferences(schema);
            if (this.options.verbose) {
                console.debug('[TSBuffer Schema Generator]', `addToOutput(${astKey}, ${name}})`, `refs.length=${refs.length}`)
            }
            for (let ref of refs) {
                if (this.options.verbose) {
                    console.debug('[TSBuffer Schema Generator]', `addToOutput(${astKey}, ${name}})`, `ref={path:${ref.path || ''}, targetName=${ref.targetName}}`)
                }

                let refPath: string;    // 实际引用路径
                if (ref.path) {
                    // 相对路径引用
                    if (ref.path.startsWith('.')) {
                        refPath = path.join(astKey, '..', ref.path)
                    }
                    // 绝对路径引用 resolveModule
                    else {
                        if (!this.options.resolveModule) {
                            throw new Error(`Must specific a resolveModule handler for resolve "${ref.path}"`);
                        }
                        refPath = this.options.resolveModule(ref.path, this.options.baseDir);
                    }
                }
                // 当前文件内引用
                else {
                    refPath = astKey;
                }

                if (this.options.verbose) {
                    console.debug('[TSBuffer Schema Generator]', `addToOutput(${astKey}, ${name}})`, `AST "${refPath}" loading`);
                }

                // load ast
                let refAst = await this._getAst(refPath, astCache);

                if (this.options.verbose) {
                    console.debug('[TSBuffer Schema Generator]', `addToOutput(${astKey}, ${name}})`, `AST "${refPath}" loaded`);
                }

                // 将要挨个寻找的refTarget
                let refTargetNames: string[] = [];
                // 文件内&Namespace内引用，从Namespace向外部 逐级寻找
                if (!ref.path && name.indexOf('.') > -1) {
                    // name: A.B.C.D
                    // refTarget: E
                    // A.B.C.E
                    // A.B.E
                    // A.E
                    // E
                    let nameArr = name.split('.');
                    for (let i = nameArr.length - 1; i >= 1; --i) {
                        let refName = '';
                        for (let j = 0; j < i; ++j) {
                            refName += `${nameArr[j]}.`
                        }
                        refTargetNames.push(refName + ref.targetName);
                    }
                }
                refTargetNames.push(ref.targetName);

                // 确认的 refTargetName
                let certainRefTargetName: string | undefined;
                for (let refTargetName of refTargetNames) {
                    if (refAst.ast[refTargetName]) {
                        certainRefTargetName = refTargetName;
                        break;
                    }
                }

                if (this.options.verbose) {
                    console.debug('[TSBuffer Schema Generator]', `addToOutput(${astKey}, ${name}})`, `refTargetName=${certainRefTargetName}`);
                }

                if (certainRefTargetName) {
                    // 修改源reference的targetName和path
                    ref.path = refAst.astKey;
                    ref.targetName = certainRefTargetName;
                    // 将ref加入output
                    await this._addToOutput(refAst.astKey, certainRefTargetName, refAst.ast[certainRefTargetName].schema, output, astCache);
                }
                else {
                    console.debug('current', astKey, name);
                    console.debug('ref', ref);
                    console.debug('schema', schema);
                    throw new Error(`Cannot find reference "${ref.targetName}" at: ${refPath}`);
                }
            }
        }
    }
}

export interface AstCache {
    [relativePath: string]: AstParserResult;
}

export interface GenerateFileSchemaOptions {
    /** 是否解除引用（生成出不包含ReferenceType的Schema），默认为false */
    flatten?: boolean;

    /** 决定该field是否被导出，默认为导出所有export及其引用的字段
     * isUsed为true的字段，无论如何都会被导出
     */
    filter?: (info: { path: string, name: string, isExport: boolean }) => boolean;

    /**
     * 需要向后兼容的Result
     * 生成结果：全兼容、部分兼容、完全不兼容
     * 兼容方式：旧字段ID不变，新字段换新ID
     */
    compatibleResult?: GenerateResult;
}

export interface OriginalSchemas {
    /**
     * 于baseDir的文件的相对路径 不带扩展名的
     * 例如 a/b/c/index.ts 的key会是 a/b/c/index 不会是 a/b/c
     */
    [path: string]: {
        [symbolName: string]: {
            schema: TSBufferSchema,
            // 经filter检测过是需要导出的使用类型
            isFiltered: boolean,
            // 有被其它任何Schema依赖
            isDependency: boolean
        }
    };
}

export interface GenerateResult {
    /**
     * 于baseDir的文件的相对路径 不带扩展名的
     * 例如 a/b/c/index.ts 的key会是 a/b/c/index 不会是 a/b/c
     */
    [path: string]: {
        [symbolName: string]: TSBufferSchema
    };
}
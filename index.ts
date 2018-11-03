import fs = require("fs");
import path = require("path");
import child_process = require("child_process");
import fsExtra = require("fs-extra");
import { NativeModuleBuilder } from "./NativeModuleBuilder"
import { FileSearch } from "./FileSearch";
import  validate = require('@webpack-contrib/schema-utils');

const optionsSchema = require("./options.schema.json");

class ElectronNativePlugin {

    private dependencies: any = {};
    private moduleOutputPaths: any = {};

    private outputPath: string;
    private options: any;
    private fileSearch: FileSearch;

    constructor(options?: any) {
        this.options = this.fillInDefaults(options);
        this.validateOptions();
        this.fileSearch = new FileSearch();
    }

    apply(compiler: any) {
        this.outputPath = compiler.options.output.path || "./dist";
        if(! fs.existsSync(this.outputPath)) {
            fs.mkdirSync(this.outputPath);
        }
        compiler.hooks.environment.tap("ElectronNativePlugin", () => this.rebuildNativeModules());
    }

    private validateOptions() {
        validate({name: "ElectronNativePlugin", schema: optionsSchema, target: this.options});
    }

    private fillInDefaults(options: any) {
        options = options || {};
        options.forceRebuild = options.forceRebuild || false;
        options.outputPath = options.outputPath || "./";
        options.pythonPath = options.pythonPath || null;
        options.debugBuild = options.debugBuild || false;
        options.parallelBuild = options.parallelBuild || false;
        options.userModules = options.userModules || [];
        options.userModules = options.userModules.map(item => { 
            return {
                source: item.source || item, 
                outputPath: item.outputPath || options.outputPath,
                debugBuild: item.debugBuild != undefined ? item.debugBuild : null
            };
        });
        return options;
    }

    private rebuildNativeModules() {
        // read the project's package json
        let dependencies = this.readProjectPackage();

        // filter out not installed optional dependencies
        let filteredDeps: string[] = [];
        for(let dep in dependencies) {
            if(!this.isModuleOptionalAndNotInstalled(dep))
                filteredDeps.push(dep);
        }

        // filter out native dependencies
        let nativeDeps: string[] = [];
        for(let dep in filteredDeps) {
            let dependency = filteredDeps[dep];
            if(this.isModuleNative(dependency))
                nativeDeps.push(dependency);
        }

        // do the Electron build itself
        let forceRebuildFlag = this.options.forceRebuild ? "-f" : "";
        let debugBuildFlag = this.options.debugBuild ? "-b" : "";
        let parallelBuildFlag = this.options.parallelBuild ? "-p" : "";
        for(let dep of nativeDeps) {
            console.log(`Rebuilding native module ${dep}...`);
            child_process.execSync(`electron-rebuild ${forceRebuildFlag} ${debugBuildFlag} ${parallelBuildFlag} -o ${dep}`, {stdio: [0, 1, 2]});
            this.saveTheDependency(dep);
        }

        // do the build of user modules
        let moduleBuilder = new NativeModuleBuilder(this.options, this.outputPath);
        this.options.userModules.forEach(m => {
            let moduleFiles = moduleBuilder.compile(m);
            if(moduleFiles != null) {
                this.dependencies[moduleFiles.nodeFile] = moduleFiles.electronFile;
                this.moduleOutputPaths[moduleFiles.nodeFile] = m.outputPath;
            }
        });

        // copy native modules
        for(let gypFile in this.dependencies) {
            // get the output path for the native module
            let outputPath = this.moduleOutputPaths[gypFile] || this.options.outputPath;
            let targetFilePath = path.join(this.outputPath, outputPath);
            // if directory does not exist, then create it
            fsExtra.ensureDirSync(targetFilePath);
            // copy the native module
            let electronNative = this.dependencies[gypFile];
            targetFilePath = path.join(targetFilePath, gypFile);
            fs.copyFileSync(electronNative, targetFilePath);
        }

         // prepare and save the substitution map
        for(let gypFile in this.dependencies) {
            let outputPath = this.moduleOutputPaths[gypFile] || this.options.outputPath;
            this.dependencies[gypFile] = path.join(outputPath, path.basename(this.dependencies[gypFile]));
        }
        fs.writeFileSync("./ElectronNativeSubstitutionMap.json", JSON.stringify(this.dependencies));
    }

    private saveTheDependency(moduleName: string) {
        const modulePath = path.resolve(path.dirname(require.resolve(moduleName)), "build/");
        let gypFile = this.fileSearch.search(modulePath, "node")[0];
        gypFile = path.basename(gypFile);
        const electronFile = this.fileSearch.search(`./node_modules/${moduleName}/bin`, "node")[0];
        this.dependencies[gypFile] = electronFile;
    }

    private isModuleOptionalAndNotInstalled(moduleName: string) {
        let modulePath = "";


        let packageJson = fs.readFileSync("./package.json").toString();
        let optionalDependencies = JSON.parse(packageJson).optionalDependencies;

        if(!(moduleName in optionalDependencies)) return false;

        try {
            modulePath = path.dirname(require.resolve(moduleName));
        }
        catch(e) {
            console.log(`[WARNING]: Module ${moduleName}, configured in your package.json as optional, not found. Skipped.`);
            return true;
        }
        return false;
    }

    private isModuleNative(moduleName: string) {
        let modulePath = "";
        try {
            modulePath = path.dirname(require.resolve(moduleName));
        }
        catch(e) {
            console.log(`[WARNING]: Module ${moduleName}, configured in your package.json, not found. Please, check your dependencies.`);
            return false;
        }
        return this.fileSearch.search(modulePath, "node").length > 0;
    }

    private readProjectPackage() {
        let packageJson = fs.readFileSync("./package.json").toString();
        let dependencies = JSON.parse(packageJson).dependencies;

        if (this.options.optionalDependencies) {
            let optionalDependencies = JSON.parse(packageJson).optionalDependencies;
            dependencies = {...dependencies, ...optionalDependencies}
        }

        return dependencies;
    }
}

export = ElectronNativePlugin;

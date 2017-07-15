import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { connect, Socket } from 'net';
// let lastSyncHash = crypto.createHash('md5').update(data).digest("hex");
import * as crypto from 'crypto';
import { SDSConnection, Hash, crypt_md5, getJanusPassword } from 'node-sds';
import * as config from './config';

const reduce = require('reduce-for-promises');


const VERSION = '8034';

const SDS_DEFAULT_TIMEOUT: number = 60 * 1000;




export type scriptT = {
    /**
     * Name of the script without extension.
     * A script is always a javascript file.
     */
    name: string,
    /**
     * If this value is set, the script is renamed after download.
     * For now only used for 'compare-script'.
     */
    rename?: string,
    path?: string,
    /**
     * Source code of script.
     */
    sourceCode?: string,
    /**
     * Output of run script.
     */
    output?: string,
    /**
     * Encryption state.
     * See enum encrypted for more information.
     */
    encrypted?: string,

    /**
     * If a script in conflict mode is uploaded, the hash value is used to
     * check, if the script (the source code of the script) on server has
     * changed since last up- or download.
     * If the script in conflict mode has been changed on server, it won't
     * be uploaded, instead 'conflict' will be set to true.
     */
    conflictMode?: boolean,
    /**
     * Hash value of the source code at the time of last synchronisation,
     * meaning at the time of last up- or download.
     * This value is only set if the script is in conflict mode.
     */
    lastSyncHash?: string,
    /**
     * Source code of the script on server.
     * Only set, if code on server has been changed after last synchronisation.
     */
    serverCode?: string,
    /**
     * conflict is set to true, if the user tried to upload a script, but
     * the source code of the script on server has been changed since last
     * up- or download.
     */
    conflict?: boolean,
    /**
     * forceUpload is set to true if conflict is true and the user decided
     * to upload and overwrite the script on server anyway.
     */
    forceUpload?: boolean
};



/**
 * Used for information that is independend from scripts.
 * For now only version is used.
 */
export type documentsT = {
    version: string
}



export type serverOperationT = (sdsConn: SDSConnection, param: any[]) => Promise<any[]>;


/**
 * This function establishes a connection to the server, calls the given operation
 * and closes the connection.
 * The operations that can be called on server using this function are implemented
 * below.
 * 
 * @param loginData 
 * @param param input parameter of the operation
 * @param serverOperation the operation to be called on server, should be one of the
 * functions that are implemented below
 */
export async function sdsSession(loginData: config.LoginData,
                                 param: any[],
                                 serverOperation: serverOperationT): Promise<any[]> {

    return new Promise<any[]>((resolve, reject) => {
        if(!loginData) {
            reject('login data missing');
        }


        // first try to get the login data
        loginData.ensureLoginData().then(() => {
            console.log('ensureLoginData successful');

            let onConnect: boolean = false;

            // create socket
            let sdsSocket = connect(loginData.port, loginData.server);

            // the callback functions for the socket are implemented below
            // actual function (serverOperation) is executed in connect callback

            // callback on connect
            // function that is called on connect event
            sdsSocket.on('connect', () => {
                onConnect = true;
                console.log('callback socket.on(connect)');

                doLogin(loginData, sdsSocket).then((sdsConnection) => {
                    
                    // call serverOperation and then close the connection in any case
                    serverOperation(sdsConnection, param).then((value) => {
                        closeConnection(sdsConnection).then(() => {
                            resolve(value);
                        }).catch((reason) => {
                            reject('close connection failed ' + reason);
                        });
                    }).catch((reason) => {
                        console.log('serverOperation -> catch: ' + reason);
                        closeConnection(sdsConnection).then(() => {
                            // reject because serverOperation went wrong
                            reject(reason);
                        }).catch((reason2) => {
                            // only show reason from catch-serverOperation!
                            reject(reason);
                        });
                    });

                }).catch((reason) => {
                    console.log('doLogin -> catch');
                    reject(reason);
                });
            });


            // callback on close
            // function that is called on close event
            sdsSocket.on('close', (hadError: boolean) => {
                console.log('callback socket.on(close)');
                if (hadError) {
                    console.log('remote closed SDS connection due to error');
                } else {
                    console.log('remote closed SDS connection');
                }
            });

            // callback on error
            // function that is called on error event
            sdsSocket.on('error', (err: any) => {
                console.log('callback socket.on(error)');
                console.log(err);
                // only reject here if on-connect couldn't start
                if(onConnect) {
                    // reject is executed in on('connect') callback 
                } else {
                    // on('connect') is not executed, so we must reject here
                    reject(err);
                }
            });



        }).catch((reason) => {
            reject(reason);
        });


    });
}


/**
 * Connect to server.
 * This function is called in function sdsSession before the operation is called.
 * 
 * @param loginData 
 * @param sdsSocket 
 */
async function doLogin(loginData: config.LoginData, sdsSocket: Socket): Promise<SDSConnection> {
    return new Promise<SDSConnection>((resolve, reject) => {
        let sdsConnection = new SDSConnection(sdsSocket);
        sdsConnection.timeout = loginData.sdsTimeout? loginData.sdsTimeout: SDS_DEFAULT_TIMEOUT;

        sdsConnection.connect('node-documents-scripting').then(() => {
            console.log('connect successful');
            let username = loginData.username;
            return sdsConnection.changeUser(username, getJanusPassword(loginData.password));

        }).then(userId => {
            loginData.userId = userId;
            console.log('changeUser successful');
            if (loginData.principal.length > 0) {
                return sdsConnection.changePrincipal(loginData.principal);
            } else {
                reject('please set principal');
            }

        }).then(() => {
            console.log('changePrincipal successful');
            return sdsConnection.callClassOperation('PartnerNet.getVersionNo', []);

        }).then((value) => {
            let docVersion = value[0];
            console.log(`Current version: ${docVersion} Required verson: ${VERSION}`);
            if(!docVersion) {
                reject(`This command is only available on DOCUMENTS`);
            } else if(Number(VERSION) > Number(docVersion)) {
                reject(`Current version: ${docVersion} Required verson: ${VERSION}`);
            } else {
                resolve(sdsConnection);
            }

        }).catch((reason) => {
            reject(reason + ` - check ".vscode/launch.json"`);
            closeConnection(sdsConnection).catch((reason) => {
                console.log(reason);
            });
        });
    });
}


/**
 * Close the connection to the server.
 * This function is called in function sdsSession after the operation
 * has been called.
 * 
 * @param sdsConnection 
 */
async function closeConnection(sdsConnection: SDSConnection): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        sdsConnection.disconnect().then(() => {
            resolve();
        }).catch((reason) => {
            reject('closeConnection failed: ' + reason);
        });
    });
}






/**
 * The following functions are the operations that can be called
 * on server using the function sdsSession.
 */




/**
 * Returns the current build version that is used with the given login data.
 * This function is called in sdsSession.
 * 
 * @param sdsConnection Set by function sdsSession
 * @param params empty
 */
export async function getDocumentsVersion(sdsConnection: SDSConnection, params: any[]): Promise<documentsT[]> {
    return new Promise<documentsT[]>((resolve, reject) => {
        sdsConnection.callClassOperation('PartnerNet.getVersionNo', []).then((value) => {
            let docVersion = value[0];
            let doc: documentsT = {version: docVersion};
            console.log('getDocumentsVersion: ' + doc.version);
            resolve([doc]);
        }).catch((reason) => {
            reject('getDocumentsVersion failed: ' + reason);
        });
    });
}


/**
 * Get names of all scripts on server.
 * 
 * @param sdsConnection 
 * @param params 
 */
export async function getScriptNamesFromServer(sdsConnection: SDSConnection, params: scriptT[]): Promise<scriptT[]> {
    return new Promise<scriptT[]>((resolve, reject) => {
        sdsConnection.callClassOperation('PortalScript.getScriptNames', []).then((scriptNames) => {
            let scripts: scriptT[] = [];
            scriptNames.forEach(function(scriptname) {
                let script: scriptT = {name: scriptname};
                scripts.push(script);
            });
            resolve(scripts);
        }).catch((reason) => {
            reject('getScriptNamesFromServer failed: ' + reason);
        });
    });
}



export async function getScriptParameters(sdsConnection: SDSConnection, params: scriptT[]): Promise<string[]> {
    return new Promise<any[]>((resolve, reject) => {
        const scriptname: string = params[0].name;
        sdsConnection.callClassOperation('PortalScript.getScriptInfoAsJSON', [scriptname]).then((param) => {
            const err = param[0];
            if(0 < err.length) {
                reject(err);
            } else if(1 < param.length) {
                let json = param[1];
                resolve([json]);
            }
        }).catch((error) => {
            reject(error);
        });
    });
}



export async function getAllParameters(sdsConnection: SDSConnection, params: scriptT[]): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
        let jsonOut: string[] = [];

        // see description of reduce in uploadAll
        return reduce(params, function(numScripts: number, _script: scriptT) {
            return getScriptParameters(sdsConnection, [_script]).then((value) => {
                const jsonScript: string = value[0];
                jsonOut.push(_script.name);
                jsonOut.push(jsonScript);
                return numScripts + 1;
            });
        }, 0).then((numScripts: number) => {
            resolve(jsonOut);
        }).catch((error: any) => {
            reject(error);
        });
    });
}




export async function getSystemUser(sdsConnection: SDSConnection, params: any[]): Promise<any[]> {
    return new Promise<any[]>((resolve, reject) => {
        sdsConnection.callClassOperation('Systemuser.get', ['test']).then((param) => {
            resolve([]);
        }).catch((reason) => {
            reject('getSystemUser failed: ' + reason);
        });
    });
}



/**
 * Upload all scripts from given list.
 * 
 * @return Array containing all uploaded scripts, should be equal to params.
 * @param sdsConnection 
 * @param params Array containing all scripts to upload.
 */
export async function uploadAll(sdsConnection: SDSConnection, params: scriptT[]): Promise<scriptT[]> {
    return new Promise<scriptT[]>((resolve, reject) => {
        let scripts: scriptT[] = [];

        if(0 === params.length) {
            resolve(scripts);
        } else {
            // reduce calls _uploadScript for every name in scriptNames,
            // in doing so every call of _uploadScript is started after
            // the previous call is finished
            return reduce(params, function(numscripts: number, _script: scriptT) {
                return uploadScript(sdsConnection, [_script]).then((value) => {
                    // this section is executed after every single _uploadScript call
                    if(0 <= value.length) {
                        let uscript = value[0];
                        scripts.push(uscript);
                    }
                    return numscripts + 1;
                });
            }, 0).then((numscripts: number) => {
                // this section is exectuted once after all _uploadScript calls are finished
                resolve(scripts);
            }).catch((error: any) => {
                reject(error);
            });
        }
    });
}



/**
 * Download all scripts from given list.
 * 
 * @return Array containing all downloaded scripts, including the source-code.
 * @param sdsConnection 
 * @param params Array containing all scripts to download.
 */
export async function downloadAll(sdsConnection: SDSConnection, params: scriptT[]): Promise<scriptT[]> {
    return new Promise<scriptT[]>((resolve, reject) => {
        let returnScripts: scriptT[] = [];
        let scripts: scriptT[] = params;

        if(0 === params.length) {
            resolve(returnScripts);
        } else {
            // see description of reduce in uploadAll
            return reduce(scripts, function(numScripts: number, script: scriptT) {
                return downloadScript(sdsConnection, [script]).then((retval) => {
                    let currentScript: scriptT = retval[0];
                    returnScripts.push(currentScript);
                    return numScripts + 1;
                });
            }, 0).then((numScripts: number) => {
                resolve(returnScripts);
            }).catch((error: any) => {
                reject(error);
            });
        }
    });
}

/**
 * Execute all scripts in given list on server.
 * 
 * @return Array containing all executed scripts, including the output.
 * @param sdsConnection 
 * @param params Array containing all scripts to execute.
 */
export async function runAll(sdsConnection: SDSConnection, params: scriptT[]): Promise<scriptT[]> {
    return new Promise<scriptT[]>((resolve, reject) => {
        let scripts: scriptT[] = [];

        // see description of reduce in uploadAll
        return reduce(params, function(numScripts: number, _script: scriptT) {
            return runScript(sdsConnection, [_script]).then((value) => {
                let script: scriptT = value[0];
                scripts.push(script);
                return numScripts + 1;
            });
        }, 0).then((numScripts: number) => {
            resolve(scripts);
        }).catch((error: any) => {
            reject(error);
        });
    });
}






/**
 * Download script.
 * 
 * @param sdsConnection 
 * @param params 
 */
export async function downloadScript(sdsConnection: SDSConnection, params: scriptT[]): Promise<scriptT[]> {
    return new Promise<scriptT[]>((resolve, reject) => {
        if(0 === params.length) {
            resolve([]);
        } else {
            
            let script: scriptT = params[0];
            sdsConnection.callClassOperation('PortalScript.downloadScript', [script.name]).then((retval) => {
                if(!script.path) {
                    reject('path missing');
                } else if(!retval[0]) {
                    reject('could not find ' + script.name + ' on server');
                } else {
                    let scriptSource = retval[0];
                    let _encryptState = retval[1];

                    let scriptPath;
                    if(script.rename) {
                        // rename script on download, only used for compare by now
                        scriptPath = path.join(script.path? script.path: '', script.rename + ".js");
                    } else {
                        scriptPath = path.join(script.path? script.path: '', script.name + ".js");
                    }

                    let noBomSourceCode = ensureNoBOM(scriptSource);
                    writeFile(noBomSourceCode, scriptPath, true).then(() => {
                        script.encrypted = _encryptState;
                        if(script.conflictMode) {
                            script.lastSyncHash = crypto.createHash('md5').update(scriptSource).digest('hex');
                        }
                        resolve([script]);
                    }).catch((reason) => {
                        reject(reason);
                    });
                }
            }).catch((reason) => {
                reject(reason);
            });
        }
    });
}

/**
 * If the given script can be uploaded, an empty list is returned.
 * If not, a script containing the server source code is returned.
 * Both cases are resolved. Reject only in case of error.
 * 
 * @param sdsConnection 
 * @param params 
 */
export async function updateScriptProperties(sdsConnection: SDSConnection, params: scriptT[]): Promise<scriptT[]> {
    return new Promise<scriptT[]>((resolve, reject) => {
        if(0 === params.length) {
            resolve([]);
        } else {

            let script: scriptT = params[0];
            sdsConnection.callClassOperation('PortalScript.downloadScript', [script.name]).then((value) => {
                if(value.length >= 2) {
                    let serverSource: string  = value[0];
                    let _encryptState: string = value[1];

                    script.serverCode = serverSource;
                    script.encrypted = _encryptState;

                    if(script.conflictMode && !script.forceUpload && script.lastSyncHash) {
                        let serverHash = crypto.createHash('md5').update(serverSource).digest('hex');
                        if(script.lastSyncHash === serverHash) {
                            console.log('checkForConflict: no changes on server');
                            resolve([script]);
                        } else {
                            console.log('checkForConflict: script changed on server');
                            script.conflict = true;
                            resolve([script]);
                        }
                    } else {
                        console.log('checkForConflict: conflictMode off or no lastSyncHash');
                        resolve([script]);
                    }
                } else {
                    console.log('checkForConflict: new file');

                    // todo: check project flag
                    // script not on server, new script, so check source code for encryption
                    // if(script.sourceCode && 0 <= script.sourceCode.indexOf('// #crypt')) {
                    //     script.encrypted = encrypted.decrypted;
                    // }
                    resolve([script]);
                }
            }).catch((reason) => {
                reject(reason);
            });
        }
    });
}

/**
 * Upload Script.
 * 
 * @param sdsConnection 
 * @param params 
 */
export async function uploadScript(sdsConnection: SDSConnection, params: scriptT[]): Promise<scriptT[]> {
    return new Promise<scriptT[]>((resolve, reject) => {
        if(0 === params.length) {
            resolve([]);
        } else {
            
            let script: scriptT = params[0];
            if(script.sourceCode) {
                let bomSourceCode = ensureBOM(script.sourceCode);
                let noBomSourceCode = ensureNoBOM(script.sourceCode);

                script.sourceCode = bomSourceCode;
                updateScriptProperties(sdsConnection, [script]).then((value) => {
                    const retscript = value[0];

                    if(!retscript.conflict) {

                        // get encryption state from downloaded script
                        script.encrypted = retscript.encrypted || 'false';

                        // create parameter for uploadScript call
                        let params = [script.name, noBomSourceCode, script.encrypted];

                        return sdsConnection.callClassOperation("PortalScript.uploadScript", params).then((value) => {
                            if(script.conflictMode) {
                                // create hash with BOM, because server returns the source-code always with BOM
                                 // todo: source-code should be uploaded with BOM
                               script.lastSyncHash = crypto.createHash('md5').update(bomSourceCode).digest("hex");
                            }
                            console.log('uploaded: ', script.name);
                            resolve([script]);
                        });
                    } else {
                        //
                        resolve([retscript]);
                    }
                }).catch((reason) => {
                    reject(reason);
                });
            } else  {
                reject('scriptname or sourcecode missing in uploadScript');
            }
        }
    });
}

/**
 * Run script.
 * 
 * @param sdsConnection 
 * @param params 
 */
export async function runScript(sdsConnection: SDSConnection, params: scriptT[]): Promise<scriptT[]> {
    return new Promise<scriptT[]>((resolve, reject) => {
        if(0 === params.length) {
            resolve([]);
        } else {
            
            let script: scriptT = params[0];
            sdsConnection.callClassOperation('PortalScript.runScript', [script.name]).then((value) => {
                if(!value || 0 === value.length) {
                    reject('could not find ' + params[0] + ' on server');
                } else {
                    script.output = value.join(os.EOL);
                    resolve([script]);
                }
            }).catch((reason) => {
                reject(reason);
            });
        }
    });
}





/**
 * Some additional helper functions.
 */






/**
 * 
 * @param data 
 * @param filename 
 * @param allowSubFolder 
 */
export async function writeFile(data: any, filename: string, allowSubFolder = false): Promise<void> {
    console.log('writeFile');

    return new Promise<void>((resolve, reject) => {
        let folder = path.dirname(filename);
        if(folder) {
            fs.writeFile(filename, data, {encoding: 'utf8'}, function(error) {
                if(error) {
                    if(error.code === 'ENOENT' && allowSubFolder) {
                        fs.mkdir(folder, function(error) {
                            if(error) {
                                reject(error);
                            } else {
                                console.log('created path: ' + folder);
                                fs.writeFile(filename, data, {encoding: 'utf8'}, function(error) {
                                    if(error) {
                                        reject(error);
                                    } else {
                                        console.log('wrote file: ' +  filename);
                                        resolve();
                                    }
                                });
                            }
                        });
                    } else {
                        reject(error);
                    }
                } else {
                    console.log('wrote file: ' +  filename);
                    resolve();
                }
            });
        } else {
            reject('error in filename');
        }
    });
}


/**
 * Return a list of all names of all JavaScript files in the given folder.
 * 
 * @param _path Foder
 * @param nameprefix 
 */
export async function getScriptsFromFolder(_path: string, nameprefix?: string): Promise<scriptT[]> {
    return new Promise<scriptT[]>((resolve, reject) => {
    
        let scripts : scriptT[] = [];

        fs.readdir(_path, function (err, files) {
            if (err) {
                reject(err);
            } else if (!files) {
                reject('unexpexted error in readdir: files is empty');
            } else {

                files.map(function (file) {
                    return path.join(_path, file);
                }).filter(function (file) {
                    return fs.statSync(file).isFile();
                }).forEach(function (file) {
                    let basename = path.basename(file);
                    if('.js' === path.extname(file) && (!nameprefix || basename.startsWith(nameprefix))) {
                        let s = getScript(file);
                        if(typeof s !== 'string') {
                            scripts.push(s);
                        }
                        // else ...reject(s)
                    }
                });

                resolve(scripts);
            }
        });
    });
}





/**
 * Create script-type with name and sourceCode from file.
 * 
 * @param file Scriptname, full path.
 */
export function getScript(file: string): scriptT | string {
    let s: scriptT;
    if(file && '.js' === path.extname(file)) {
        try {
            // todo check with fs.stat because if file looks relative readFileSync
            // tries to read it from C:\Program Files (x86)\Microsoft VS Code\file
            let sc = fs.readFileSync(file, 'utf8');
            let _name = path.basename(file, '.js');
            return {name: _name, sourceCode: sc};
        } catch(err) {
            return err;
        }
    } else {
        return 'only javascript files allowed';
    }
}


const NODEJS_UTF8_BOM = '\ufeff';
// not used for now...
// actually it's only required for DOCUMENTS 4 support,
// in that case we shouldn't send UTF 8 without BOM
function ensureBOM(sourceCode: string): string {
    if(sourceCode.length >= 3 && sourceCode.startsWith(NODEJS_UTF8_BOM)) {
        return sourceCode;
    } else {
        return NODEJS_UTF8_BOM + sourceCode;
    }
}
function ensureNoBOM(sourceCode: string): string {
    return sourceCode.replace(/^\ufeff/, '');
}

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import * as vs from 'vscode';
import * as vscode from 'vscode';

interface IScriptVersion {
	version: number;
	modified: number;
}

export class Creator implements vs.Disposable {
	private languageService: ts.LanguageService;
	private vsOutputChannel: vs.OutputChannel;
	private scriptVersion = new Map<string, IScriptVersion>();
	private scriptFileNames = new Array<string>();
	private editor: vs.TextEditor;

	constructor() {
		this.languageService = ts.createLanguageService(
			this.getLanguageServiceHost(),
			ts.createDocumentRegistry()
		);
	}

	private typeDefaultLookup(type) {
		const defaults = {
			string: 'string',
			number: '0',
			boolean: 'false'
		};
		return defaults[type] || type;
	}

	private getCompilerOptions() {
		const fileDir = (
			path.dirname(this.editor.document.fileName).replace(/\\/g, '/')
		);
		const configPath = ts.findConfigFile(
			fileDir,
			ts.sys.fileExists
		);

		const configJson = ts.readConfigFile(
			configPath,
			ts.sys.readFile
		);
		if (configJson.error) {
			vs.window.showErrorMessage(
				configJson.error.messageText.toString()
			);

			return {};
		}
		const cwd = configPath.replace(/tsconfig.json/i, '');
		const config = ts.parseJsonConfigFileContent(
			configJson.config,
			{
				readDirectory: ts.sys.readDirectory,
				fileExists: ts.sys.fileExists,
				readFile: ts.sys.readFile,
				useCaseSensitiveFileNames: false
			},
			cwd
		);
		if (config.errors.length) {
			config.errors.map(err => err.messageText).forEach(error => {
				vs.window.showErrorMessage(error.toString());
			});
			return {};
		}

		return config.options;
	}

	public createFromUsage(editor: vs.TextEditor, inline: boolean = false) {
		this.editor = editor;

		const filePath = this.getDocumentFileName(this.editor.document);

		this.addOrUpdateFile(filePath);

		const program = this.languageService.getProgram();
		const sourceFile = program.getSourceFile(filePath);

		const caret = editor.selection.start;

		const position = ts.getPositionOfLineAndCharacter(
			sourceFile,
			caret.line,
			caret.character
		);

		const focusedNode = this.findChildForPosition(sourceFile, position);

		if (focusedNode.kind !== ts.SyntaxKind.Identifier) {
			return this.showFailureMessage();
		}

		this.insertCodeSnippet(
			filePath,
			position,
			sourceFile,
			focusedNode,
			inline
		);
	}

	private insertCodeSnippet(
		filePath: string,
		position: number,
		sourceFile: ts.SourceFile,
		focusedNode: ts.Node,
		inline: boolean
	) {
		const getSignatureHelp = this.languageService.getSignatureHelpItems;
		const help = getSignatureHelp(filePath, position);
		if (!help) {
			return this.showFailureMessage();
		}

		const item = help.items[help.selectedItemIndex].parameters[help.argumentIndex];

		const label = item.displayParts.map(part => (
			part.text
		)).reduce((s, v) => (
			s + v
		));

		const types = label.split(' | ').filter(type => type !== 'undefined');

		if (label.match(/: any/)) {
			return this.showFailureMessage();
		}

		const possibleTypes = [
			ts.SyntaxKind.VariableDeclarationList,
			ts.SyntaxKind.ReturnStatement,
			ts.SyntaxKind.ExpressionStatement,
			ts.SyntaxKind.CallExpression
		];
		const fullNode = (function findParent(node, typeIndex, depth) {
			depth += 1;
			if (typeof possibleTypes[typeIndex] === 'undefined') {
				return null;
			}
			if (!node) {
				return findParent(focusedNode, typeIndex + 1, 0);
			}

			if (node.kind === possibleTypes[typeIndex]) {
				return node;
			} else {
				return findParent(node.parent, typeIndex, depth);
			}
		})(focusedNode, 0, 0);

		if (!fullNode) {
			return this.showFailureMessage();
		}

		const previousLine = fullNode.getFullText().split('\n').filter(line => {
			return line.trim();
		}).join('\n');
		const indent = previousLine.match(/\s*/).toString();
		const codeSnippet = new vs.SnippetString();
		if (!inline) {
			codeSnippet.appendText(indent);
		}

		let tabIndex = 0;

		if (!inline) {
			const varName = focusedNode.getFullText().trim();
			codeSnippet.appendText('const ' + varName + ' = ');
		}
		types.forEach((rawType) => {
			let isArray = rawType.match(/\[\]$/);
			let type = rawType.replace(/.*?: /, '');
			let isFunction = false;

			if (type.match(/=>/)) {
				isFunction = true;
				if (!inline) {
					type = type.replace(/=>.*/, '=> {\n' + indent + '}');
				} else {
					// Strip types as they should be inferred
					type = type.replace(/([a-z0-9+]):.*?([,)])/ig, '$1$2');
					type = type.replace(/=>.*/, '=> {}');
				}
			}

			if (types.length > 1) {
				// If type is constructor
				if (type.match(/(^[A-Z]|\.[A-Z])/) && !isFunction) {
					if (isArray) {
						codeSnippet.appendPlaceholder(
							`[new ${type}()];`,
							++tabIndex
						);
					} else {
						codeSnippet.appendPlaceholder(
							`new ${type}();`,
							++tabIndex
						);
					}
				} else {
					if (isArray) {
						codeSnippet.appendPlaceholder(
							`[${this.typeDefaultLookup(type)}];`,
							++tabIndex
						);
					} else {
						codeSnippet.appendPlaceholder(
							`${this.typeDefaultLookup(type)};`,
							++tabIndex
						);
					}
				}
			} else {
				// If type is constructor
				if (type.match(/(^[A-Z]|\.[A-Z])/) && !isFunction) {
					if (isArray) {
						codeSnippet.appendText('[');
					}
					codeSnippet.appendText('new ' + type + '(');
					codeSnippet.appendTabstop(++tabIndex);
					codeSnippet.appendText(')');
					if (isArray) {
						codeSnippet.appendText(']');
					}
				} else {
					if (isArray) {
						codeSnippet.appendText('[');
					}
					if (type === 'string') {
						codeSnippet.appendText('\'');
						codeSnippet.appendPlaceholder(
							this.typeDefaultLookup(type),
							++tabIndex
						);
						codeSnippet.appendText('\'');
					} else {
						if (isFunction && inline) {
							const parts = type.split('}');
							codeSnippet.appendText(parts[0]);
							codeSnippet.appendPlaceholder(
								'/* code... */',
								++tabIndex
							);
							codeSnippet.appendText('}');
						} else {
							codeSnippet.appendPlaceholder(
								this.typeDefaultLookup(type),
								++tabIndex
							);
						}
					}
					if (isArray) {
						codeSnippet.appendText(']');
					}
				}
				if (!inline) {
					codeSnippet.appendText(';\n');
				}
			}
		});
		if (types.length > 1) {
			codeSnippet.appendText('\n');
		}

		const nextArgumentIndex = help.argumentIndex + 1;
		const splitPreviousLine = previousLine.split(',');

		if (!inline) {
			splitPreviousLine.forEach((part, i) => {
				if (i === nextArgumentIndex) {
					const argName = part.match(/[a-z0-9]+/i).toString();
					const parts = part.split(argName);
					codeSnippet.appendText(parts[0]);
					codeSnippet.appendPlaceholder(argName, ++tabIndex);
					codeSnippet.appendText(parts[1]);
				} else {
					codeSnippet.appendText(part);
				}

				const notLast = i !== splitPreviousLine.length - 1;
				if (notLast) {
					codeSnippet.appendText(',');
				}
			});
		}

		if (inline) {
			const range = this.getNodeRange(sourceFile, focusedNode);
			this.editor.insertSnippet(codeSnippet, range);
		} else {
			const range = this.getNodeRange(sourceFile, fullNode, true);
			this.editor.insertSnippet(codeSnippet, range);
		}

		if (!inline) {
			vscode.commands.executeCommand('editor.action.triggerParameterHints');
		}
	}

	private getNodeRange(
		sourceFile: ts.SourceFile,
		node: any,
		overrideCharacter: boolean = false
	) {
		const lineStart = ts.getLineAndCharacterOfPosition(
			sourceFile,
			node.getStart()
		);
		const lineEnd = ts.getLineAndCharacterOfPosition(
			sourceFile,
			node.getEnd()
		);

		const start = new vs.Position
			(lineStart.line,
			overrideCharacter ? 0 : lineStart.character
			);

		const end = new vs.Position
			(lineEnd.line,
			lineEnd.character
			);

		const range = new vs.Range(start, end);
		return range;
	}

	private getLanguageServiceHost(): ts.LanguageServiceHost {
		return {
			getScriptFileNames: () => (this.scriptFileNames),
			getScriptVersion: (fileName) => (
				this.scriptVersion[fileName] &&
				this.scriptVersion[fileName].version.toString()
			),
			getScriptSnapshot: (fileName) => {
				let fileContent;
				try {
					// Need to fetch document from editor instead of disk
					const doc = this.editor.document;
					if (path.resolve(doc.fileName) === fileName) {
						fileContent = doc.getText();
						this.scriptVersion[fileName].version += 1;
					} else {
						fileContent = ts.sys.readFile(fileName);
					}
				} catch (e) {
					return undefined;
				}
				const snapshot = ts.ScriptSnapshot.fromString(fileContent);
				// We need to increment version on depended files otherwise
				// they can cause cache issues.
				const stat = fs.statSync(fileName);
				if (!this.scriptVersion[fileName]) {
					this.scriptVersion[fileName] = {
						version: 0,
						modified: Date.now()
					};
				}
				const cacheModified = (
					this.scriptVersion[fileName]
				);
				const diskModified = stat.mtime.getTime();
				if (diskModified > cacheModified) {
					this.scriptVersion[fileName].version += 1;
					this.scriptVersion[fileName].modified = diskModified;
				}
				return snapshot;
			},
			getCurrentDirectory: () => (
				process.cwd()
			),
			getCompilationSettings: () => this.getCompilerOptions(),
			getDefaultLibFileName: (options) => (
				ts.getDefaultLibFilePath(options)
			),
			fileExists: ts.sys.fileExists,
			readFile: ts.sys.readFile,
			readDirectory: ts.sys.readDirectory
		};
	}

	private addOrUpdateFile(filePath: string) {
		const modifiedTime = fs.statSync(filePath).mtime.getTime();
		if (!this.scriptVersion[filePath]) {
			this.scriptFileNames.push(filePath);
			this.scriptVersion[filePath] = {
				version: 0,
				modified: modifiedTime
			};
		} else {
			if (this.scriptVersion[filePath].modified < modifiedTime) {
				this.scriptVersion[filePath].version += 1;
			}
		}
	}

	private showFailureMessage() {
		vs.window.showErrorMessage(
			'Could not find type information at caret position.'
		);
	}

	private getDocumentFileName(
		document: vs.TextDocument
	) {
		const fileName = path.resolve(document.fileName);

		return (
			ts.sys.useCaseSensitiveFileNames ?
				fileName.toLowerCase() :
				fileName
		);
	}

	private findChildForPosition(
		node: ts.Node,
		position: number
	) {
		let lastMatchingNode: ts.Node;

		const findChildFunc = (n: ts.Node) => {
			const start = n.pos;
			const end = n.end;

			if (start > position) {
				return;
			}

			if (start <= position && end >= position) {
				lastMatchingNode = n;
			}

			n.getChildren().forEach(findChildFunc);
		};

		findChildFunc(node);

		return lastMatchingNode;
	}

	public dispose() {
		if (this.vsOutputChannel) {
			this.vsOutputChannel.dispose();
		}

		this.languageService.dispose();
	}
}

import * as vs from 'vscode';

import { Creator } from './creator';

let creator: Creator;

function lazyInitializeDocumenter() {
	if (!creator) {
		creator = new Creator();
	}
}

function languageIsSupported(document: vs.TextDocument) {
	return (
		document.languageId === 'typescript' ||
		document.languageId === 'typescriptreact'
	);
}

function verifyLanguageSupport(
	document: vs.TextDocument,
	commandName: string
) {
	if (!languageIsSupported(document)) {
		vs.window.showWarningMessage(`"${commandName}" only supports TypeScript files.`);
		return false;
	}

	return true;
}

function runCommand(
	commandName: string,
	document: vs.TextDocument,
	implFunc: () => void
) {
	if (!verifyLanguageSupport(document, commandName)) {
		return;
	}

	try {
		lazyInitializeDocumenter();
		implFunc();
	} catch (e) {
		console.error(e);
	}
}

export function activate(context: vs.ExtensionContext): void {
	context.subscriptions.push(
		vs.commands.registerCommand('createFromUsage.createVariable', () => {
			const commandName = 'Create From Usage';
			runCommand(
				commandName,
				vs.window.activeTextEditor.document,
				() => {
					creator.createFromUsage(
						vs.window.activeTextEditor
					);
				}
			);
		}
	));
}

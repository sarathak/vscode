/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import {TPromise} from 'vs/base/common/winjs.base';
import uri from 'vs/base/common/uri';
import paths = require('vs/base/common/paths');
import extfs = require('vs/base/node/extfs');
import objects = require('vs/base/common/objects');
import {RunOnceScheduler} from 'vs/base/common/async';
import collections = require('vs/base/common/collections');
import {IWorkspaceContextService} from 'vs/platform/workspace/common/workspace';
import {LegacyWorkspaceContextService} from 'vs/workbench/services/workspace/common/contextService';
import {IEnvironmentService} from 'vs/platform/environment/common/environment';
import {OptionsChangeEvent, EventType} from 'vs/workbench/common/events';
import {IEventService} from 'vs/platform/event/common/event';
import {IDisposable, dispose} from 'vs/base/common/lifecycle';
import {readFile, writeFile} from 'vs/base/node/pfs';
import {JSONPath} from 'vs/base/common/json';
import {applyEdits} from 'vs/base/common/jsonFormatter';
import {setProperty} from 'vs/base/common/jsonEdit';
import errors = require('vs/base/common/errors');
import {getDefaultValues} from 'vs/platform/configuration/common/model';
import {IConfigFile, consolidate, CONFIG_DEFAULT_NAME, newConfigFile} from 'vs/workbench/services/configuration/common/model';
import {IConfigurationServiceEvent}  from 'vs/platform/configuration/common/configuration';
import {IWorkbenchConfigurationService} from 'vs/workbench/services/configuration/common/configuration';
import {EventType as FileEventType, FileChangeType, FileChangesEvent} from 'vs/platform/files/common/files';
import {IConfigurationRegistry, Extensions} from 'vs/platform/configuration/common/configurationRegistry';
import {Registry} from 'vs/platform/platform';
import Event, {Emitter} from 'vs/base/common/event';

interface IStat {
	resource: uri;
	isDirectory?: boolean;
	children?: { resource: uri; }[];
}

interface IContent {
	resource: uri;
	value: string;
}

interface ILoadConfigResult {
	config: any;
	parseErrors?: string[];
}

export class ConfigurationService implements IWorkbenchConfigurationService, IDisposable {

	public _serviceBrand: any;

	private static RELOAD_CONFIGURATION_DELAY = 50;

	private _onDidUpdateConfiguration: Emitter<IConfigurationServiceEvent>;

	private cachedConfig: ILoadConfigResult;

	private bulkFetchFromWorkspacePromise: TPromise<any>;
	private workspaceFilePathToConfiguration: { [relativeWorkspacePath: string]: TPromise<IConfigFile> };
	private toDispose: IDisposable[];
	private reloadConfigurationScheduler: RunOnceScheduler;

	constructor(
		@IWorkspaceContextService private contextService: IWorkspaceContextService,
		@IEventService private eventService: IEventService,
		@IEnvironmentService private environmentService: IEnvironmentService,
		private workspaceSettingsRootFolder: string = '.vscode'
	) {
		this.toDispose = [];

		this._onDidUpdateConfiguration = new Emitter<IConfigurationServiceEvent>();
		this.toDispose.push(this._onDidUpdateConfiguration);

		this.workspaceFilePathToConfiguration = Object.create(null);
		this.cachedConfig = {
			config: Object.create(null)
		};

		this.registerListeners();
	}

	get onDidUpdateConfiguration(): Event<IConfigurationServiceEvent> {
		return this._onDidUpdateConfiguration.event;
	}

	private registerListeners(): void {
		this.toDispose.push(this.eventService.addListener2(FileEventType.FILE_CHANGES, events => this.handleFileEvents(events)));
		this.toDispose.push(Registry.as<IConfigurationRegistry>(Extensions.Configuration).onDidRegisterConfiguration(() => this.onDidRegisterConfiguration()));
		this.toDispose.push(this.eventService.addListener2(EventType.WORKBENCH_OPTIONS_CHANGED, e => this.onOptionsChanged(e)));
	}

	private onOptionsChanged(e: OptionsChangeEvent): void {
		if (e.key === 'globalSettings') {
			this.handleConfigurationChange();
		}
	}

	public initialize(): TPromise<void> {
		return this.doLoadConfiguration().then(() => null);
	}

	public getConfiguration<T>(section?: string): T {
		let result = section ? this.cachedConfig.config[section] : this.cachedConfig.config;

		const parseErrors = this.cachedConfig.parseErrors;
		if (parseErrors && parseErrors.length > 0) {
			if (!result) {
				result = Object.create(null);
			}
			result.$parseErrors = parseErrors;
		}

		return result;
	}

	public reloadConfiguration(section?: string): TPromise<any> {

		// Reset caches to ensure we are hitting the disk
		this.bulkFetchFromWorkspacePromise = null;
		this.workspaceFilePathToConfiguration = Object.create(null);

		// Load configuration
		return this.doLoadConfiguration(section);
	}

	private doLoadConfiguration(section?: string): TPromise<any> {

		// Load globals
		const globals = this.loadGlobalConfiguration();

		// Load workspace locals
		return this.loadWorkspaceConfiguration().then(values => {

			// Consolidate
			const consolidated = consolidate(values);

			// Override with workspace locals
			const merged = objects.mixin(
				objects.clone(globals.contents), 	// target: global/default values (but dont modify!)
				consolidated.contents,				// source: workspace configured values
				true								// overwrite
			);

			let parseErrors = [];
			if (consolidated.parseErrors) {
				parseErrors = consolidated.parseErrors;
			}

			if (globals.parseErrors) {
				parseErrors.push.apply(parseErrors, globals.parseErrors);
			}

			return {
				config: merged,
				parseErrors
			};
		}).then((res: ILoadConfigResult) => {
			this.cachedConfig = res;

			return this.getConfiguration(section);
		});
	}

	private loadGlobalConfiguration(): { contents: any; parseErrors?: string[]; } {
		const globalSettings = (<LegacyWorkspaceContextService>this.contextService).getOptions().globalSettings;

		return {
			contents: objects.mixin(
				objects.clone(getDefaultValues()),	// target: default values (but don't modify!)
				globalSettings,						// source: global configured values
				true								// overwrite
			),
			parseErrors: []
		};
	}

	private loadWorkspaceConfiguration(section?: string): TPromise<{ [relativeWorkspacePath: string]: IConfigFile }> {

		// Return early if we don't have a workspace
		if (!this.contextService.getWorkspace()) {
			return TPromise.as(Object.create(null));
		}

		// once: when invoked for the first time we fetch *all* json
		// files using the bulk stats and content routes
		if (!this.bulkFetchFromWorkspacePromise) {
			this.bulkFetchFromWorkspacePromise = resolveStat(this.contextService.toResource(this.workspaceSettingsRootFolder)).then(stat => {
				if (!stat.isDirectory) {
					return TPromise.as([]);
				}

				return resolveContents(stat.children.filter(stat => paths.extname(stat.resource.fsPath) === '.json').map(stat => stat.resource));
			}, (err) => {
				if (err) {
					return []; // never fail this call
				}
			}).then((contents: IContent[]) => {
				contents.forEach(content => this.workspaceFilePathToConfiguration[this.contextService.toWorkspaceRelativePath(content.resource)] = TPromise.as(newConfigFile(content.value)));
			}, errors.onUnexpectedError);
		}

		// on change: join on *all* configuration file promises so that
		// we can merge them into a single configuration object. this
		// happens whenever a config file changes, is deleted, or added
		return this.bulkFetchFromWorkspacePromise.then(() => {
			return TPromise.join(this.workspaceFilePathToConfiguration);
		});
	}

	private onDidRegisterConfiguration(): void {

		// a new configuration was registered (e.g. from an extension) and this means we do have a new set of
		// configuration defaults. since we already loaded the merged set of configuration (defaults < global < workspace),
		// we want to update the defaults with the new values. So we take our cached config and mix it into the new
		// defaults that we got, overwriting any value present.
		this.cachedConfig.config = objects.mixin(objects.clone(getDefaultValues()), this.cachedConfig.config, true /* overwrite */);

		// emit this as update to listeners
		this._onDidUpdateConfiguration.fire({ config: this.cachedConfig.config });
	}

	private handleConfigurationChange(): void {
		if (!this.reloadConfigurationScheduler) {
			this.reloadConfigurationScheduler = new RunOnceScheduler(() => {
				this.doLoadConfiguration().then(config => this._onDidUpdateConfiguration.fire({ config: config })).done(null, errors.onUnexpectedError);
			}, ConfigurationService.RELOAD_CONFIGURATION_DELAY);

			this.toDispose.push(this.reloadConfigurationScheduler);
		}

		if (!this.reloadConfigurationScheduler.isScheduled()) {
			this.reloadConfigurationScheduler.schedule();
		}
	}

	private handleFileEvents(event: FileChangesEvent): void {
		const events = event.changes;
		let affectedByChanges = false;

		for (let i = 0, len = events.length; i < len; i++) {
			const workspacePath = this.contextService.toWorkspaceRelativePath(events[i].resource);
			if (!workspacePath) {
				continue; // event is not inside workspace
			}

			// Handle case where ".vscode" got deleted
			if (workspacePath === this.workspaceSettingsRootFolder && events[i].type === FileChangeType.DELETED) {
				this.workspaceFilePathToConfiguration = Object.create(null);
				affectedByChanges = true;
			}

			// outside my folder or not a *.json file
			if (paths.extname(workspacePath) !== '.json' || !paths.isEqualOrParent(workspacePath, this.workspaceSettingsRootFolder)) {
				continue;
			}

			// insert 'fetch-promises' for add and update events and
			// remove promises for delete events
			switch (events[i].type) {
				case FileChangeType.DELETED:
					affectedByChanges = collections.remove(this.workspaceFilePathToConfiguration, workspacePath);
					break;
				case FileChangeType.UPDATED:
				case FileChangeType.ADDED:
					this.workspaceFilePathToConfiguration[workspacePath] = resolveContent(events[i].resource).then(content => newConfigFile(content.value), errors.onUnexpectedError);
					affectedByChanges = true;
			}
		}

		if (affectedByChanges) {
			this.handleConfigurationChange();
		}
	}

	public hasWorkspaceConfiguration(): boolean {
		return !!this.workspaceFilePathToConfiguration[`${this.workspaceSettingsRootFolder}/${CONFIG_DEFAULT_NAME}.json`];
	}

	public dispose(): void {
		this.toDispose = dispose(this.toDispose);
	}

	// TODO implement
	public setUserConfiguration(key: any, value: any): Thenable<void> {
		const appSettingsPath = this.environmentService.appSettingsPath;

		return readFile(appSettingsPath, 'utf8').then(content => {
			const {tabSize, insertSpaces} = this.getConfiguration<{ tabSize: number; insertSpaces: boolean }>('editor');
			const path: JSONPath = typeof key === 'string' ? (<string>key).split('.') : <JSONPath>key;
			const edits = setProperty(content, path, value, { insertSpaces, tabSize, eol: '\n' });

			content = applyEdits(content, edits);

			return writeFile(appSettingsPath, content, 'utf8');
		});
	}
}

// node.hs helper functions

function resolveContents(resources: uri[]): TPromise<IContent[]> {
	const contents: IContent[] = [];

	return TPromise.join(resources.map(resource => {
		return resolveContent(resource).then(content => {
			contents.push(content);
		});
	})).then(() => contents);
}

function resolveContent(resource: uri): TPromise<IContent> {
	return readFile(resource.fsPath).then(contents => ({ resource, value: contents.toString() }));
}

function resolveStat(resource: uri): TPromise<IStat> {
	return new TPromise<IStat>((c, e) => {
		extfs.readdir(resource.fsPath, (error, children) => {
			if (error) {
				if ((<any>error).code === 'ENOTDIR') {
					c({ resource });
				} else {
					e(error);
				}
			} else {
				c({
					resource,
					isDirectory: true,
					children: children.map(child => { return { resource: uri.file(paths.join(resource.fsPath, child)) }; })
				});
			}
		});
	});
}
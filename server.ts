import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as path from "path";
import * as util from "util";
import * as url from "url";

import { Emitter } from "vs/base/common/event";
import { sanitizeFilePath } from "vs/base/common/extpath";
import { getMediaMime } from "vs/base/common/mime";
import { extname } from "vs/base/common/path";
import { UriComponents, URI } from "vs/base/common/uri";
import { IPCServer, ClientConnectionEvent, StaticRouter } from "vs/base/parts/ipc/common/ipc";
import { mkdirp } from "vs/base/node/pfs";
import { LogsDataCleaner } from "vs/code/electron-browser/sharedProcess/contrib/logsDataCleaner";
import { IConfigurationService } from "vs/platform/configuration/common/configuration";
import { ConfigurationService } from "vs/platform/configuration/node/configurationService";
import { IDialogService } from "vs/platform/dialogs/common/dialogs";
import { DialogChannelClient } from "vs/platform/dialogs/node/dialogIpc";
import { IEnvironmentService, ParsedArgs } from "vs/platform/environment/common/environment";
import { EnvironmentService } from "vs/platform/environment/node/environmentService";
import { IExtensionManagementService, IExtensionGalleryService } from "vs/platform/extensionManagement/common/extensionManagement";
import { ExtensionGalleryChannel } from "vs/platform/extensionManagement/node/extensionGalleryIpc";
import { ExtensionGalleryService } from "vs/platform/extensionManagement/node/extensionGalleryService";
import { ExtensionManagementChannel } from "vs/platform/extensionManagement/node/extensionManagementIpc";
import { ExtensionManagementService } from "vs/platform/extensionManagement/node/extensionManagementService";
import { SyncDescriptor } from "vs/platform/instantiation/common/descriptors";
import { InstantiationService } from "vs/platform/instantiation/common/instantiationService";
import { ServiceCollection } from "vs/platform/instantiation/common/serviceCollection";
import { ILocalizationsService } from "vs/platform/localizations/common/localizations";
import { LocalizationsService } from "vs/platform/localizations/node/localizations";
import { getLogLevel, ILogService } from "vs/platform/log/common/log";
import { LogLevelSetterChannel } from "vs/platform/log/common/logIpc";
import { SpdLogService } from "vs/platform/log/node/spdlogService";
import { IProductConfiguration } from "vs/platform/product/common/product";
import product from "vs/platform/product/node/product";
import { ConnectionType, ConnectionTypeRequest } from "vs/platform/remote/common/remoteAgentConnection";
import { REMOTE_FILE_SYSTEM_CHANNEL_NAME } from "vs/platform/remote/common/remoteAgentFileSystemChannel";
import { IRequestService } from "vs/platform/request/node/request";
import { RequestService } from "vs/platform/request/node/requestService";
import { ITelemetryService } from "vs/platform/telemetry/common/telemetry";
import { NullTelemetryService } from "vs/platform/telemetry/common/telemetryUtils";
import { RemoteExtensionLogFileName } from "vs/workbench/services/remote/common/remoteAgentService";
// import { TelemetryService } from "vs/workbench/services/telemetry/electron-browser/telemetryService";
import { IWorkbenchConstructionOptions } from "vs/workbench/workbench.web.api";

import { Connection, ManagementConnection, ExtensionHostConnection } from "vs/server/connection";
import { ExtensionEnvironmentChannel, FileProviderChannel, getUriTransformer } from "vs/server/channel";
import { Protocol } from "vs/server/protocol";

export enum HttpCode {
	Ok = 200,
	NotFound = 404,
	BadRequest = 400,
}

export interface Options {
	WORKBENCH_WEB_CONGIGURATION: IWorkbenchConstructionOptions;
	REMOTE_USER_DATA_URI: UriComponents | URI;
	PRODUCT_CONFIGURATION: IProductConfiguration | null;
	CONNECTION_AUTH_TOKEN: string;
}

export interface Response {
	content?: string | Buffer;
	code?: number;
	headers: http.OutgoingHttpHeaders;
}

export class HttpError extends Error {
	public constructor(message: string, public readonly code: number) {
		super(message);
		// @ts-ignore
		this.name = this.constructor.name;
		Error.captureStackTrace(this, this.constructor);
	}
}

export abstract class Server {
	// The underlying web server.
	protected readonly server: http.Server;

	protected rootPath = path.resolve(__dirname, "../../..");

	private listenPromise: Promise<string> | undefined;

	public constructor(private readonly port: number) {
		this.server = http.createServer(async (request, response): Promise<void> => {
			try {
				if (request.method !== "GET") {
					throw new HttpError(
						`Unsupported method ${request.method}`,
						HttpCode.BadRequest,
					);
				}

				const parsedUrl = url.parse(request.url || "", true);

				const fullPath = decodeURIComponent(parsedUrl.pathname || "/");
				const match = fullPath.match(/^(\/?[^/]*)(.*)$/);
				const [, base, requestPath] = match
					? match.map((p) => p !== "/" ? p.replace(/\/$/, "") : p)
					: ["", "", ""];

				const { content, headers, code } = await this.handleRequest(
					base, requestPath, parsedUrl, request,
				);
				response.writeHead(code || HttpCode.Ok, {
					"Cache-Control": "max-age=86400",
					// TODO: ETag?
					...headers,
				});
				response.end(content);
			} catch (error) {
				if (error.code === "ENOENT" || error.code === "EISDIR") {
					error = new HttpError("Not found", HttpCode.NotFound);
				}
				response.writeHead(typeof error.code === "number" ? error.code : 500);
				response.end(error.message);
			}
		});
	}

	public listen(): Promise<string> {
		if (!this.listenPromise) {
			this.listenPromise = new Promise((resolve, reject) => {
				this.server.on("error", reject);
				this.server.listen(this.port, () => {
					resolve(this.address());
				});
			});
		}
		return this.listenPromise;
	}

	public address(): string {
		const address = this.server.address();
		const endpoint = typeof address !== "string"
			? ((address.address === "::" ? "localhost" : address.address) + ":" + address.port)
			: address;
		return `http://${endpoint}`;
	}

	protected abstract handleRequest(
		base: string,
		requestPath: string,
		parsedUrl: url.UrlWithParsedQuery,
		request: http.IncomingMessage,
	): Promise<Response>;

	protected async getResource(filePath: string): Promise<Response> {
		const content = await util.promisify(fs.readFile)(filePath);
		return {
			content,
			headers: {
				"Content-Type": getMediaMime(filePath) || {
					".css": "text/css",
					".html": "text/html",
					".js": "text/javascript",
					".json": "application/json",
				}[extname(filePath)] || "text/plain",
			},
		};
	}
}

export class MainServer extends Server {
	// Used to notify the IPC server that there is a new client.
	public readonly _onDidClientConnect = new Emitter<ClientConnectionEvent>();
	public readonly onDidClientConnect = this._onDidClientConnect.event;

	// This is separate instead of just extending this class since we can't
	// use properties in the super call. This manages channels.
	private readonly ipc = new IPCServer(this.onDidClientConnect);

	// Persistent connections. These can reconnect within a timeout.
	private readonly connections = new Map<ConnectionType, Map<string, Connection>>();

	private readonly services = new ServiceCollection();

	public constructor(
		port: number,
		private readonly webviewServer: WebviewServer,
		args: ParsedArgs,
	) {
		super(port);

		this.server.on("upgrade", async (request, socket) => {
			const protocol = this.createProtocol(request, socket);
			try {
				await this.connect(await protocol.handshake(), protocol);
			} catch (error) {
				protocol.dispose(error);
			}
		});

		const environmentService = new EnvironmentService(args, process.execPath);
		const logService = new SpdLogService(RemoteExtensionLogFileName, environmentService.logsPath, getLogLevel(environmentService));
		this.ipc.registerChannel("loglevel", new LogLevelSetterChannel(logService));

		const router = new StaticRouter((context: any) => {
			return context.clientId === "renderer";
		});

		this.services.set(ILogService, logService);
		this.services.set(IEnvironmentService, environmentService);
		this.services.set(IConfigurationService, new SyncDescriptor(ConfigurationService, [environmentService.machineSettingsResource]));
		this.services.set(IRequestService, new SyncDescriptor(RequestService));
		this.services.set(IExtensionGalleryService, new SyncDescriptor(ExtensionGalleryService));
		this.services.set(ITelemetryService, NullTelemetryService); // TODO: telemetry
		this.services.set(IDialogService, new DialogChannelClient(this.ipc.getChannel("dialog", router)));
		this.services.set(IExtensionManagementService, new SyncDescriptor(ExtensionManagementService));

		const instantiationService = new InstantiationService(this.services);

		this.services.set(ILocalizationsService, instantiationService.createInstance(LocalizationsService));

		instantiationService.invokeFunction(() => {
			instantiationService.createInstance(LogsDataCleaner);
			this.ipc.registerChannel(REMOTE_FILE_SYSTEM_CHANNEL_NAME, new FileProviderChannel(logService));
			this.ipc.registerChannel("remoteextensionsenvironment", new ExtensionEnvironmentChannel(environmentService, logService));
			const extensionsService = this.services.get(IExtensionManagementService) as IExtensionManagementService;
			const extensionsChannel = new ExtensionManagementChannel(extensionsService, (context) => getUriTransformer(context.remoteAuthority));
			this.ipc.registerChannel("extensions", extensionsChannel);
			const galleryService = this.services.get(IExtensionGalleryService) as IExtensionGalleryService;
			const galleryChannel = new ExtensionGalleryChannel(galleryService);
			this.ipc.registerChannel("gallery", galleryChannel);
		});
	}

	public async listen(): Promise<string> {
		const environment = (this.services.get(IEnvironmentService) as EnvironmentService);
		const mkdirs = Promise.all([
			environment.extensionsPath,
		].map((p) => mkdirp(p)));
		const [address] = await Promise.all([
			super.listen(),
			mkdirs,
		]);
		return address;
	}

	protected async handleRequest(
		base: string,
		requestPath: string,
		parsedUrl: url.UrlWithParsedQuery,
		request: http.IncomingMessage,
	): Promise<Response> {
		switch (base) {
			case "/":
				return this.getRoot(request, parsedUrl);
			case "/node_modules":
			case "/out":
				return this.getResource(path.join(this.rootPath, base, requestPath));
			// TODO: this setup means you can't request anything from the root if it
			// starts with /node_modules or /out, although that's probably low risk.
			// There doesn't seem to be a really good way to solve this since some
			// resources are requested by the browser (like the extension icon) and
			// some by the file provider (like the extension README). Maybe add a
			// /resource prefix and a file provider that strips that prefix?
			default:
				return this.getResource(path.join(base, requestPath));
		}
	}

	private async getRoot(request: http.IncomingMessage, parsedUrl: url.UrlWithParsedQuery): Promise<Response> {
		const htmlPath = path.join(
			this.rootPath,
			'out/vs/code/browser/workbench/workbench.html',
		);

		let content = await util.promisify(fs.readFile)(htmlPath, "utf8");

		const remoteAuthority = request.headers.host as string;
		const transformer = getUriTransformer(remoteAuthority);

		const webviewEndpoint = await this.webviewServer.listen();

		const cwd = process.env.VSCODE_CWD || process.cwd();
		const workspacePath = parsedUrl.query.workspace as string | undefined;
		const folderPath = !workspacePath ? parsedUrl.query.folder as string | undefined || cwd: undefined;

		const options: Options = {
			WORKBENCH_WEB_CONGIGURATION: {
				workspaceUri: workspacePath
					? transformer.transformOutgoing(URI.file(sanitizeFilePath(workspacePath, cwd)))
					: undefined,
				folderUri: folderPath
					? transformer.transformOutgoing(URI.file(sanitizeFilePath(folderPath, cwd)))
					: undefined,
				remoteAuthority,
				webviewEndpoint,
			},
			REMOTE_USER_DATA_URI: transformer.transformOutgoing(
				(this.services.get(IEnvironmentService) as EnvironmentService).webUserDataHome,
			),
			PRODUCT_CONFIGURATION: product,
			CONNECTION_AUTH_TOKEN: "",
		};

		Object.keys(options).forEach((key) => {
			content = content.replace(`"{{${key}}}"`, `'${JSON.stringify(options[key])}'`);
		});

		content = content.replace('{{WEBVIEW_ENDPOINT}}', webviewEndpoint);

		return {
			content,
			headers: {
				"Content-Type": "text/html",
			},
		};
	}

	private createProtocol(request: http.IncomingMessage, socket: net.Socket): Protocol {
		if (request.headers.upgrade !== "websocket") {
			throw new Error("HTTP/1.1 400 Bad Request");
		}

		const options = {
			reconnectionToken: "",
			reconnection: false,
			skipWebSocketFrames: false,
		};

		if (request.url) {
			const query = url.parse(request.url, true).query;
			if (query.reconnectionToken) {
				options.reconnectionToken = query.reconnectionToken as string;
			}
			if (query.reconnection === "true") {
				options.reconnection = true;
			}
			if (query.skipWebSocketFrames === "true") {
				options.skipWebSocketFrames = true;
			}
		}

		return new Protocol(
			request.headers["sec-websocket-key"] as string,
			socket,
			options,
		);
	}

	private async connect(message: ConnectionTypeRequest, protocol: Protocol): Promise<void> {
		switch (message.desiredConnectionType) {
			case ConnectionType.ExtensionHost:
			case ConnectionType.Management:
				const debugPort = await this.getDebugPort();
				const ok = message.desiredConnectionType === ConnectionType.ExtensionHost
					? (debugPort ? { debugPort } : {})
					: { type: "ok" };

				if (!this.connections.has(message.desiredConnectionType)) {
					this.connections.set(message.desiredConnectionType, new Map());
				}

				const connections = this.connections.get(message.desiredConnectionType)!;
				const token = protocol.options.reconnectionToken;

				if (protocol.options.reconnection && connections.has(token)) {
					protocol.sendMessage(ok);
					const buffer = protocol.readEntireBuffer();
					protocol.dispose();
					return connections.get(token)!.reconnect(protocol, buffer);
				}

				if (protocol.options.reconnection || connections.has(token)) {
					throw new Error(protocol.options.reconnection
						? "Unrecognized reconnection token"
						: "Duplicate reconnection token"
					);
				}

				protocol.sendMessage(ok);

				let connection: Connection;
				if (message.desiredConnectionType === ConnectionType.Management) {
					connection = new ManagementConnection(protocol);
					this._onDidClientConnect.fire({
						protocol,
						onDidClientDisconnect: connection.onClose,
					});
				} else {
					connection = new ExtensionHostConnection(
						protocol, this.services.get(ILogService) as ILogService,
					);
				}
				connections.set(protocol.options.reconnectionToken, connection);
				connection.onClose(() => {
					connections.delete(protocol.options.reconnectionToken);
				});
				break;
			case ConnectionType.Tunnel: return protocol.tunnel();
			default: throw new Error("Unrecognized connection type");
		}
	}

	/**
	 * TODO: implement.
	 */
	private async getDebugPort(): Promise<number | undefined> {
		return undefined;
	}
}

export class WebviewServer extends Server {
	protected async handleRequest(
		base: string,
		requestPath: string,
	): Promise<Response> {
		const webviewPath = path.join(
			this.rootPath,
			"out/vs/workbench/contrib/webview/browser/pre",
		);

		if (base === "/") {
			base = "/index.html";
		}

		return this.getResource(path.join(webviewPath, base, requestPath));
	}
}

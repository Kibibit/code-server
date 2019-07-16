import * as cp from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as util from "util";

import { getPathFromAmdModule } from "vs/base/common/amd";
import { getMediaMime as vsGetMediaMime } from "vs/base/common/mime";
import { extname } from "vs/base/common/path";
import { URITransformer, IRawURITransformer } from "vs/base/common/uriIpc";
import { mkdirp } from "vs/base/node/pfs";

export const tmpdir = path.join(os.tmpdir(), "code-server");

export const generateCertificate = async (): Promise<{ cert: string, certKey: string }> => {
	const paths = {
		cert: path.join(tmpdir, "self-signed.cert"),
		certKey: path.join(tmpdir, "self-signed.key"),
	};

	const exists = await Promise.all([
		util.promisify(fs.exists)(paths.cert),
		util.promisify(fs.exists)(paths.certKey),
	]);

	await mkdirp(tmpdir);

	if (!exists[0] || !exists[1]) {
		const pem = require.__$__nodeRequire(path.resolve(__dirname, "../node_modules/pem/lib/pem")) as typeof import("pem");
		const certs = await new Promise<import("pem").CertificateCreationResult>((resolve, reject): void => {
			pem.createCertificate({ selfSigned: true }, (error, result) => {
				if (error) {
					return reject(error);
				}
				resolve(result);
			});
		});
		await Promise.all([
			util.promisify(fs.writeFile)(paths.cert, certs.certificate),
			util.promisify(fs.writeFile)(paths.certKey, certs.serviceKey),
		]);
	}

	return paths;
};

let secure: boolean;
export const useHttpsTransformer = (): void => {
	secure = true;
};

export const uriTransformerPath = (): string => {
	return getPathFromAmdModule(
		require,
		"vs/server/src/uriTransformerHttp" + (secure ? "s": ""),
	);
};

export const getUriTransformer = (remoteAuthority: string): URITransformer => {
	const rawURITransformerFactory = <any>require.__$__nodeRequire(uriTransformerPath());
	const rawURITransformer = <IRawURITransformer>rawURITransformerFactory(remoteAuthority);
	return new URITransformer(rawURITransformer);
};

export const generatePassword = async (length: number = 24): Promise<string> => {
	const buffer = Buffer.alloc(Math.ceil(length / 2));
	await util.promisify(crypto.randomFill)(buffer);
	return buffer.toString("hex").substring(0, length);
};

export const getMediaMime = (filePath?: string): string => {
	return filePath && (vsGetMediaMime(filePath) || {
		".css": "text/css",
		".html": "text/html",
		".js": "text/javascript",
		".json": "application/json",
	}[extname(filePath)]) || "text/plain";
};

export const isWsl = async (): Promise<boolean> => {
	return process.platform === "linux"
		&& os.release().toLowerCase().indexOf("microsoft") !== -1
		|| (await util.promisify(fs.readFile)("/proc/version", "utf8"))
			.toLowerCase().indexOf("microsoft") !== -1;
};

export const open = async (url: string): Promise<void> => {
	let command: string;
	const args = <string[]>[];
	const options = <cp.SpawnOptions>{};
	const platform = await isWsl() ? "wsl" : process.platform;
	switch (platform) {
		case "darwin":
			command = "open";
			break;
		case "win32":
		case "wsl":
			command = platform === "wsl" ? "cmd.exe" : "cmd";
			args.push("/c", "start", '""', "/b");
			url = url.replace(/&/g, "^&");
		default:
			command = "xdg-open";
			break;
	}
	args.push(url);
	const proc = cp.spawn(command, args, options);
	await new Promise((resolve, reject) => {
		proc.on("error", reject);
		proc.on("close", (code) => {
			return code !== 0
				? reject(new Error(`Failed to open with code ${code}`))
				: resolve();
		});
	});
};

import { readFileSync } from "fs";

export const VERSION = "0.1.0";
export const SECRET_PUBLIC_KEY = readFileSync(__dirname + "/../.ssh/key_new", "utf-8");
export const SECRET_PRIVATE_KEY = readFileSync(__dirname + "/../.ssh/key_new.pem", "utf-8");
export const SECRET_PASSPHRASE = readFileSync(__dirname + "/../.ssh/passphrase", "utf-8");

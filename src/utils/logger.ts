import {ChalkInstance} from "chalk";

export type Logger = {
    info: (msg: string, ...optionalParams: unknown[]) => void;
    debug: (msg: string, ...optionalParams: unknown[]) => void;
    error: (msg: string, ...optionalParams: unknown[]) => void;
    warn: (msg: string, ...optionalParams: unknown[]) => void;
};

export const getLogger = (prefix: string, chalk: ChalkInstance): Logger => ({
    info: (msg: string, ...optionalParams: unknown[]) => {
        console.info(`${chalk.bold(`[${prefix}]`)} ${chalk(msg)}`, ...optionalParams);
    },
    debug: (msg: string, ...optionalParams: unknown[]) => {
        // Use a subtle color for debug logs if desired
        console.info(`${chalk.bold.gray(`[${prefix}]`)} ${chalk.gray(msg)}`, ...optionalParams);
    },
    error: (msg: string, ...optionalParams: unknown[]) => {
        console.info(`${chalk.bold.red(`[${prefix}]`)} ${chalk.red(msg)}`, ...optionalParams);
    },
    warn: (msg: string, ...optionalParams: unknown[]) => {
        console.info(`${chalk.bold.yellow(`[${prefix}]`)} ${chalk.yellow(msg)}`, ...optionalParams);
    }
});

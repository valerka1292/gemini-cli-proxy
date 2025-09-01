import {ChalkInstance} from "chalk";

export type Logger = {
    info: (msg: string) => void;
    error: (msg: string, ...optionalParams: unknown[]) => void;
};

export const getLogger = (prefix: string, chalk: ChalkInstance) => ({
    info: (msg: string, ...optionalParams: unknown[]) => {
        console.info(`${chalk.bold(`[${prefix}]`)} ${chalk(msg)}`, ...optionalParams);
    },
    error: (msg: string, ...optionalParams: unknown[]) => {
        console.info(`${chalk.bold.red(`[${prefix}]`)} ${chalk.red(msg)}`, ...optionalParams);
    }
});

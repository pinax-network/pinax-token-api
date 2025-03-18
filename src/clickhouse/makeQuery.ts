import * as crypto from 'node:crypto';
import client from "./client.js";

import { logger } from "../logger.js";
import * as prometheus from "../prometheus.js";

import type { ResponseJSON } from "@clickhouse/client-web";
import { isProgressRow, ProgressRow } from "@clickhouse/client";
import { config } from "../config.js";
import { Progress } from 'fastmcp';

export async function makeQuery<T = unknown>(
    query: string,
    query_params?: Record<string, unknown>,
    database?: string,
    reportProgressMCP?: (progress: Progress) => Promise<void>
) {
    const query_id = crypto.randomUUID();
    logger.trace({ query_id, database, query, query_params });

    const response = await client(database).query({ query, query_params, format: "JSONEachRowWithProgress", query_id });
    const stream = response.stream<T>();
    const data: T[] = [];
    let rows_before_limit_at_least = 0;
    let statistics = {
        bytes_read: 0,
        rows_read: 0,
        elapsed: 0
    };

    // Stream rows for tracking query progress
    for await (const rows of stream) {
        for (const row of rows) {
            try {
                const decodedRow = row.json() as ProgressRow | { row?: T, rows_before_limit_at_least?: number, meta?: any[]; };
                if (isProgressRow(decodedRow)) {
                    // Send notification if query is coming from MCP
                    if (reportProgressMCP)
                        reportProgressMCP({
                            progress: Number(decodedRow.progress.read_rows),
                            total: Number(decodedRow.progress.total_rows_to_read)
                        });

                    statistics = {
                        bytes_read: Number(decodedRow.progress.read_bytes),
                        rows_read: Number(decodedRow.progress.read_rows),
                        elapsed: Number(decodedRow.progress.elapsed_ns) / 10 ** 9,
                    };
                } else if (decodedRow.rows_before_limit_at_least) {
                    rows_before_limit_at_least = decodedRow.rows_before_limit_at_least;
                } else if (decodedRow.row) {
                    data.push(decodedRow.row);
                }
            } catch (err) {
                throw new Error(`Error streaming response: ${err}`);
            }
        }
    }

    const responseJson: ResponseJSON<T> = { data, statistics, rows: data.length, rows_before_limit_at_least };
    prometheus.queries.inc();

    if (response.query_id !== query_id) throw new Error(`Wrong query ID for query: sent ${query_id} / received ${response.query_id}`);

    if (responseJson.statistics) {
        prometheus.bytes_read.observe(responseJson.statistics.bytes_read);
        prometheus.rows_read.observe(responseJson.statistics.rows_read);
        prometheus.elapsed_seconds.observe(responseJson.statistics.elapsed);

        if (responseJson.statistics.rows_read > config.maxRowsTrigger || responseJson.statistics.bytes_read > config.maxBytesTrigger)
            prometheus.large_queries.inc({
                query_id,
                bytes_read: responseJson.statistics.bytes_read,
                rows_read: responseJson.statistics.rows_read,
                elapsed_seconds: responseJson.statistics.elapsed
            });
    }

    logger.trace({ query_id: response.query_id, statistics: responseJson.statistics, rows: responseJson.rows, rows_before_limit_at_least: responseJson.rows_before_limit_at_least });
    return responseJson;
}
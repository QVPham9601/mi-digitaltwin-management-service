#!/usr/bin/env shell
# Copy the `intact` database to `intact_m1` (M1 live state, §4.5/§6).
#
# The evaluation never writes to `intact`. mongodump streams the archive
# straight into mongorestore, and --drop makes a fresh copy idempotent.
#
# Env: MONGODB_URI (default mongodb://localhost:27017/intact) — only the host
# part is used; the source database is always the URI's database name.
set -euo pipefail

URI="${MONGODB_URI:-mongodb://localhost:27017/intact}"

mongodump --uri "$URI" --archive | \
  mongorestore --archive --nsFrom 'intact.*' --nsTo 'intact_m1.*' --drop

count() {
  mongosh --quiet --eval "
    const uri = '$URI'.split('/').slice(0, -1).join('/');
    const db = connect(uri + '/$1');
    const scenarios = db.scenarios.countDocuments({});
    const executions = db.scenarios.aggregate([{ \$project: { n: { \$size: { \$ifNull: ['\$executions', []] } } } }, { \$group: { _id: null, n: { \$sum: '\$n' } } }]).toArray();
    print('scenarios=' + scenarios +
      ' executions=' + ((executions[0] && executions[0].n) || 0) +
      ' reports=' + db.executionreports.countDocuments({}));
  "
}

echo "Database counts after the copy:"
echo "  intact:    $(count intact)"
echo "  intact_m1: $(count intact_m1)"

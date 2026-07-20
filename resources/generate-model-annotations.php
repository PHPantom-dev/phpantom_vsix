<?php

// Bundled `artisan tinker` script for the "Generate Model Annotations" command.
//
// The extension feeds this file to `php artisan tinker` on stdin (with the
// leading `<?php` tag stripped) so the application boots exactly once. It scans
// the application's own directory for Eloquent models, reads each model's
// columns from the live database connection, maps them to PHP types (honouring
// the model's `$casts`), and prints a single JSON payload wrapped in marker
// strings so the extension can extract it from PsySH's surrounding output.
//
// It never writes anything: the extension owns the docblock edits. Booting the
// app is a one-time editor convenience and is never fed back into the language
// server, per the extension/server boundary.

$errors = [];
$models = [];

// PSR-4 prefix map, used to turn an absolute model path into its fully-qualified
// class name deterministically (no tokenising, no executing unknown files).
$psr4Path = base_path('vendor/composer/autoload_psr4.php');
$psr4 = is_file($psr4Path) ? require $psr4Path : [];

$fqcnFromFile = function (string $path) use ($psr4): ?string {
    $real = realpath($path);
    $norm = str_replace('\\', '/', $real !== false ? $real : $path);
    foreach ($psr4 as $prefix => $dirs) {
        foreach ((array) $dirs as $dir) {
            $realDir = realpath($dir);
            if ($realDir === false) {
                continue;
            }
            $normDir = rtrim(str_replace('\\', '/', $realDir), '/');
            if ($normDir !== '' && strpos($norm, $normDir . '/') === 0) {
                $rel = substr($norm, strlen($normDir) + 1);
                $rel = preg_replace('/\.php$/i', '', $rel);
                $sub = str_replace('/', '\\', $rel);
                return trim($prefix, '\\') . '\\' . $sub;
            }
        }
    }
    return null;
};

// Only scan the application's own code (the `app/` directory), never vendor.
$appPath = app_path();
$files = [];
if (is_dir($appPath)) {
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($appPath, FilesystemIterator::SKIP_DOTS)
    );
    foreach ($iterator as $file) {
        if ($file->isFile() && strtolower($file->getExtension()) === 'php') {
            $files[] = $file->getPathname();
        }
    }
}

// Map a raw database column type (e.g. "varchar(255)", "bigint", "datetime") to
// the PHP type a developer sees when reading the attribute.
$dbToPhp = function (?string $dbType): string {
    $type = strtolower((string) $dbType);
    $type = trim(preg_replace('/\(.*$/', '', $type));
    // Drop qualifiers such as "unsigned" in "int unsigned".
    $type = trim(explode(' ', $type)[0]);

    if (in_array($type, ['int', 'integer', 'bigint', 'smallint', 'tinyint', 'mediumint'], true)) {
        return 'int';
    }
    if (in_array($type, ['bool', 'boolean'], true)) {
        return 'bool';
    }
    if (in_array($type, ['float', 'double', 'real'], true)) {
        return 'float';
    }
    if (in_array($type, ['decimal', 'numeric', 'money'], true)) {
        // Laravel returns decimals as strings to preserve precision.
        return 'string';
    }
    if (in_array($type, ['date', 'datetime', 'timestamp', 'datetimetz', 'timestamptz'], true)) {
        return '\\Illuminate\\Support\\Carbon';
    }
    if (in_array($type, ['json', 'jsonb'], true)) {
        return 'array';
    }
    return 'string';
};

// Map a model `$casts` entry to a PHP type. Returns null for opaque custom casts
// so the caller can fall back to the column's storage type.
$castToPhp = function (string $cast): ?string {
    $lower = strtolower($cast);
    $base = explode(':', $lower)[0];
    if ($base === 'encrypted') {
        $inner = substr($lower, strlen('encrypted:'));
        $base = $inner === '' ? 'string' : explode(':', $inner)[0];
        if ($base === '') {
            $base = 'string';
        }
    }

    switch ($base) {
        case 'int':
        case 'integer':
            return 'int';
        case 'real':
        case 'float':
        case 'double':
            return 'float';
        case 'decimal':
            return 'string';
        case 'string':
        case 'hashed':
        case 'encrypted':
            return 'string';
        case 'bool':
        case 'boolean':
            return 'bool';
        case 'object':
            return '\\stdClass';
        case 'array':
        case 'json':
            return 'array';
        case 'collection':
            return '\\Illuminate\\Support\\Collection';
        case 'date':
        case 'datetime':
        case 'timestamp':
            return '\\Illuminate\\Support\\Carbon';
        case 'immutable_date':
        case 'immutable_datetime':
            return '\\Carbon\\CarbonImmutable';
    }

    // Backed enum casts resolve to the enum type; other custom casts are opaque.
    if (function_exists('enum_exists') && enum_exists($cast)) {
        return '\\' . ltrim($cast, '\\');
    }
    return null;
};

foreach ($files as $path) {
    $fqcn = $fqcnFromFile($path);
    if ($fqcn === null) {
        continue;
    }

    try {
        if (!class_exists($fqcn)) {
            continue;
        }
        $reflection = new ReflectionClass($fqcn);
    } catch (\Throwable $e) {
        continue;
    }

    if (!$reflection->isSubclassOf(\Illuminate\Database\Eloquent\Model::class) || $reflection->isAbstract()) {
        continue;
    }

    try {
        $model = new $fqcn();
        $schema = $model->getConnection()->getSchemaBuilder();
        $table = $model->getTable();

        $columns = [];
        if (method_exists($schema, 'getColumns')) {
            foreach ($schema->getColumns($table) as $column) {
                $columns[] = [
                    'name' => $column['name'],
                    'type' => $column['type_name'] ?? ($column['type'] ?? null),
                    'nullable' => (bool) ($column['nullable'] ?? false),
                ];
            }
        } else {
            // Older Laravel without schema introspection: names are reliable,
            // types are best-effort, nullability is unavailable.
            foreach ($schema->getColumnListing($table) as $name) {
                $type = null;
                try {
                    $type = $schema->getColumnType($table, $name);
                } catch (\Throwable $e) {
                    // doctrine/dbal not installed; leave the type unknown.
                }
                $columns[] = ['name' => $name, 'type' => $type, 'nullable' => false];
            }
        }

        if (empty($columns)) {
            continue;
        }

        $casts = $model->getCasts();
        $properties = [];
        foreach ($columns as $column) {
            $name = $column['name'];
            $php = null;
            if (isset($casts[$name])) {
                $php = $castToPhp((string) $casts[$name]);
            }
            if ($php === null) {
                $php = $dbToPhp($column['type']);
            }
            if ($column['nullable']) {
                $php .= '|null';
            }
            $properties[] = ['name' => $name, 'type' => $php];
        }

        $models[] = [
            'class' => $fqcn,
            'file' => realpath($path) !== false ? realpath($path) : $path,
            'properties' => $properties,
        ];
    } catch (\Throwable $e) {
        $errors[] = $fqcn . ': ' . $e->getMessage();
    }
}

echo '===PHPANTOM_MODELS_START===';
echo json_encode(['models' => $models, 'errors' => $errors]);
echo '===PHPANTOM_MODELS_END===';

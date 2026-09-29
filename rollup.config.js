import typescript from '@rollup/plugin-typescript'

export default {
    input: 'src/app.ts',
    output: {
        file: 'dist/app.js',
        format: 'esm',
    },
    onwarn: (warning) => {
        if (warning.code === 'UNRESOLVED_IMPORT') return
    },
    plugins: [
        typescript({
            tsconfig: './tsconfig.json',
            // Solo transpila el código de la app; evita arrastrar configs .js
            // de la raíz que rompían el parseo con el plugin anterior.
            include: ['src/**/*.ts'],
            exclude: ['node_modules', 'dist', '**/*.test.ts', '**/*.spec.ts'],
            // El build de producción no necesita los .d.ts.
            declaration: false,
            declarationMap: false,
        }),
    ],
}

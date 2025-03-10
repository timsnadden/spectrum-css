/*!
Copyright 2023 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under
the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
OF ANY KIND, either express or implied. See the License for the specific language
governing permissions and limitations under the License.
*/

const path = require('path');

const gulp = require('gulp');
const through = require('through2');

function getCSSVariableReference(value) {
  if (value[0] === '$') {
    value = value.substr(1);

    // Strip the stop information
    value = value.replace(/colorStopData\..*?\.colorTokens\./, 'global-color.');
    value = value.replace(/colorStopData\..*?\.colorAliases\./, 'alias.');
    value = value.replace(/colorStopData\..*?\.colorSemantics\./, 'semantic.');
    // Strip the scale information
    value = value.replace(/scaleData\..*?\.dimensionTokens\./, 'global-dimension.');
    value = value.replace(/scaleData\..*?\.dimensionAliases\./, 'alias.');
    // Sub in proper names for globals
    value = value.replace(/colorGlobals\./, 'global-color.');
    value = value.replace(/dimensionGlobals\./, 'global-dimension.static-');
    value = value.replace(/fontGlobals\./, 'global-font.');
    value = value.replace(/animationGlobals\./, 'global-animation.');
    value = value.replace(/staticAliases\./, 'alias.');

    let parts = value.split('.');
    return '--spectrum-' + parts.join('-');
  }
  return value;
}

function getCSSVarName(prefix, key) {
  key = prefix ? `${prefix}-${key}` : key;
  key = `--spectrum-${key}`;
  return key;
}

function getCSSVar(prefix, key, value) {
  key = getCSSVarName(prefix, key);
  if (value[0] === '$') {
    const reference = getCSSVariableReference(value);
    return `  ${key}: var(${reference});
`;
  } else {
    value = processValue(key, value);
    return `  ${key}: ${value};
`;
  }
}

function initializeObject(array) {
  return array.reduce(function(a, v) {
    a[v] = {}; return a;
  }, {});
}

function populateObject(parentObject, keysOfParent, keyOfChild) {
  let obj = {}
  for (let key of keysOfParent) {
    obj[key] = parentObject[key][keyOfChild];
  }
  return obj;
}

function processValue(name, value) {
  if (name.indexOf('animation') !== -1) {
    if (value[0] === '(') {
      return `cubic-bezier${value}`;
    } else if (name.match(/delay$/) && value.indexOf('ms') === -1) {
      return `${value}ms`;
    }
    return value;
  }
  if (name.match(/opacity/) && typeof (value) === 'string' && value.substr(-1) === '%') {
    return parseInt(value, 10) / 100;
  }
  return value;
}

function isColorValue(key, value) {
  return (
    key.match(/opacity/) ||
    key.match(/-color(-|$)/) ||
    value.match(/rgba\(|rgb\(|transparent/) ||
    value.match(/\$color/)
  );
}

const dropTokens = {
  'name': true,
  'description': true,
  'status:': true,
  'varBaseName': true
};

function calculateOverrides(objects, processValue) {
  let identical = {};
  let overrides = {};
  for (let objectName of Object.keys(objects)) {
    overrides[objectName] = {};
  }

  // Get all the keys from all the objects
  let keys = [];
  for (let object of Object.values(objects)) {
    for (let key in object) {
      if (keys.indexOf(key) === -1) {
        keys.push(key);
      }
    }
  }

  // Assume we have the same keys in each object
  for (let key of keys) {
    let isIdentical = true;
    let value;

    for (let [objectName, object] of Object.entries(objects)) {
      value = object[key];

      if (dropTokens[key]) {
        overrides[objectName][key] = value;
        identical[key] = value;
        continue;
      }

      let compareValue = processValue(object[key]);

      // Check if the value is the same the same in all other objects
      for (let [otherObjectName, otherObject] of Object.entries(objects)) {
        let otherValue = otherObject[key];
        let otherCompareValue = processValue(otherObject[key]);

        if (!isIdentical || compareValue !== otherCompareValue) {
          isIdentical = false;
          overrides[otherObjectName][key] = otherValue;
          overrides[objectName][key] = value;
        }
      }
    }

    if (isIdentical) {
      identical[key] = value;
    }
  }

  return [identical, overrides];
}

function generateDNAFiles() {
  const dnaJSONPath = path.join(path.dirname(require.resolve('@adobe/spectrum-express-tokens-deprecated')), '..', 'dist', 'data', 'json', 'dna-linked.json');
  return gulp.src(dnaJSONPath)
    .pipe(through.obj(function translateJSON(file, enc, cb) {

      let pushFile = (contents, fileName, folder) => {
        let vinylFile = file.clone({
          contents: false
        });
        vinylFile.path = path.join(file.base, folder || '', fileName);
        vinylFile.contents = Buffer.from(contents);
        this.push(vinylFile);
      };

      let generateCSSFile = (sections, fileName, folder) => {
        let contents = `:root {
`;

        sections.forEach(section => {
          let prefix = section.varBaseName;
          for (let key in section) {
            if (dropTokens[key]) {
              continue;
            }

            let value = section[key];
            if (value[0] === '[' && value[value.length - 1] === ']') {
              console.error(`Skipping ${prefix}-${key}, value is an array`);
              continue;
            }

            if (value.startsWith('rgb(')) {
              // Make -rgb variables for everything that's an actual rgb()
              contents += getCSSVar(prefix, key + '-rgb', value.replace(/^rgb\((.*?)\)/, '$1'));
              contents += getCSSVar(prefix, key, `rgb(var(${getCSSVarName(prefix, key)}-rgb))`);
            }
            else {
              contents += getCSSVar(prefix, key, value);
            }
          }
        });

        contents += `}
`;

        pushFile(contents, `spectrum-${fileName}.css`, folder);
      };

      let generateFiles = (sections, fileName, folder = '') => {
        generateCSSFile(sections, fileName, `css/${folder}`);
      };

      let data = JSON.parse(String(file.contents));
      let dnaData = data.dna;
      let metadata = {
        'dna-version': dnaData.version
      };

      // Get the list of stops and scales
      let stops = Object.keys(dnaData.colorStopData).filter(stopName => {
        return dnaData.colorStopData[stopName].colorTokens.status !== 'Deprecated';
      });
      let scales = Object.keys(dnaData.scaleData);
      let components = Object.keys(dnaData.components[stops[0]][scales[0]]).filter(componentName => {
        // Ok this is gross, but we have to skip this bad boy because it duplicates tokens from selectlist!
        return componentName !== 'select';
      });

      // Anything that doesn't consistently reference the same variable or value between stops/scales
      let componentColorOverrides = initializeObject(stops);
      let componentDimensionOverrides = initializeObject(scales);

      // Globals
      [
        'colorGlobals',
        'fontGlobals',
        'dimensionGlobals',
        'animationGlobals',
        'staticAliases'
      ].forEach(key => {
        generateCSSFile([dnaData[key]], key, 'css/globals');
      });

      // Elements
      let jsElementVariables = initializeObject(components);
      let componentVariables = initializeObject(components);
      let colorVariables = {};
      let dimensionVariables = {};
      let cssFilesGenerated = {};
      let overriddenTokens = {};

      function addColorVariable(componentName, varName, value, varBaseName, stopName, stateName) {
        // Strip invalid # from placeholder variables
        varName = varName.replace('#', '_');

        if (stateName && stateName !== 'default') {
          varName += `-${stateName}`;
        }

        let fullName = `${varBaseName}-${varName}`;
        let cssVariableName = getCSSVariableReference(value);
        if (colorVariables[fullName] && colorVariables[fullName].cssVariableName !== cssVariableName) {
          // logger.debug(`Found override for ${fullName} (${colorVariables[fullName].cssVariableName} vs ${cssVariableName})`);
          componentColorOverrides[colorVariables[fullName].name][fullName] = colorVariables[fullName].value;
          componentColorOverrides[stopName][fullName] = value;
          overriddenTokens[fullName] = true;
          delete componentVariables[componentName][fullName];
        } else if (!overriddenTokens[fullName]) {
          componentVariables[componentName][fullName] = value;
        }
        colorVariables[fullName] = {
          name: stopName,
          value: value,
          cssVariableName: cssVariableName
        };
        jsElementVariables[componentName][varName] = value;
      }

      function addDimensionVariable(componentName, varName, value, varBaseName, scaleName, stateName) {
        // Strip invalid # from placeholder variables
        varName = varName.replace('#', '_');

        if (stateName && stateName !== 'default') {
          varName += `-${stateName}`;
        }

        let fullName = `${varBaseName}-${varName}`;
        let cssVariableName = getCSSVariableReference(value);
        if (dimensionVariables[fullName] && dimensionVariables[fullName].cssVariableName !== cssVariableName) {
          componentDimensionOverrides[dimensionVariables[fullName].name][fullName] = dimensionVariables[fullName].value;
          componentDimensionOverrides[scaleName][fullName] = value;
          overriddenTokens[fullName] = true;
          delete componentVariables[componentName][fullName];
        } else if (!overriddenTokens[fullName]) {
          componentVariables[componentName][fullName] = value;
        }
        dimensionVariables[fullName] = {
          name: scaleName,
          value: value,
          cssVariableName: cssVariableName
        };
        jsElementVariables[componentName][varName] = value;
      }

      for (let stopName of stops) {
        let stop = dnaData.components[stopName];

        for (let scaleName of scales) {
          let scale = stop[scaleName];

          for (let componentName of components) {
            let component = scale[componentName];

            for (let variantName in component) {
              let variant = component[variantName];

              let metadataKeyBase = 'spectrum-' + componentName + (variantName === 'default' ? '' : `-${variantName}`);
              metadata[`${metadataKeyBase}-name`] = variant.name;
              metadata[`${metadataKeyBase}-description`] = variant.description;
              metadata[`${metadataKeyBase}-status`] = variant.status;
              metadata[`${metadataKeyBase}-version`] = variant.version;

              if (variant.states) {
                for (let stateName in variant.states) {
                  let state = variant.states[stateName];
                  if (stateName === 'text-color') console.log({
                      variant
                    })
                  for (let key in state) {
                    let value = state[key];
                    let varName = key;
                    if (isColorValue(varName, value)) {
                      addColorVariable(componentName, varName, value, variant.varBaseName, stopName, stateName);
                    } else {
                      addDimensionVariable(componentName, varName, value, variant.varBaseName, scaleName, stateName);
                    }
                  }
                }
              }

              if (variant.colors) {
                for (let key in variant.colors) {
                  let value = variant.colors[key];
                  let varName = key;
                  addColorVariable(componentName, varName, value, variant.varBaseName, stopName);
                }
              }

              if (variant.dimensions) {
                for (let key in variant.dimensions) {
                  let value = variant.dimensions[key];
                  let varName = key;
                  addDimensionVariable(componentName, varName, value, variant.varBaseName, scaleName);
                }
              }

              if (variant.animation) {
                for (let key in variant.animation) {
                  let value = variant.animation[key];
                  let varName = key;
                  addDimensionVariable(componentName, varName, value, variant.varBaseName, scaleName);
                }
              }
            }
          }
        }
      }

      for (let componentName of components) {
        generateCSSFile([
          componentVariables[componentName]
        ], componentName, 'css/components');
        cssFilesGenerated[componentName] = true;
      }

      pushFile(JSON.stringify(metadata, null, 2), 'spectrum-metadata.json', 'json/');

      // Determine alias overrides
      let [colorAliases,] = calculateOverrides(populateObject(dnaData.colorStopData, stops, 'colorAliases'), getCSSVariableReference);

      // Remove aliases with the same values from colorstops
      for (let aliasName in colorAliases) {
        if (dropTokens[aliasName]) {
          continue;
        }
        for (let stopName in dnaData.colorStopData) {
          let stop = dnaData.colorStopData[stopName];
          delete stop.colorAliases[aliasName];
        }
      }

      // Write out common aliases
      generateCSSFile([
        colorAliases
      ], 'colorAliases', 'css/globals/');

      // Determine semantic overrides
      let [colorSemantics,] = calculateOverrides(populateObject(dnaData.colorStopData, stops, 'colorSemantics'), getCSSVariableReference);

      // Remove semantics with the same values from colorstops
      for (let semanticName in colorSemantics) {
        if (dropTokens[semanticName]) {
          continue;
        }
        for (let stopName in dnaData.colorStopData) {
          let stop = dnaData.colorStopData[stopName];
          delete stop.colorSemantics[semanticName];
        }
      }

      generateCSSFile([
        colorSemantics
      ], 'colorSemantics', 'css/globals/');

      // Write out stops
      for (let stopName in dnaData.colorStopData) {
        let stop = dnaData.colorStopData[stopName];
        if (stop.colorTokens.status === 'Deprecated') {
          continue;
        }

        generateFiles([
          stop.colorTokens,
          stop.colorAliases,
          stop.colorSemantics,
          componentColorOverrides[stopName]
        ], stopName, 'themes');
      }

      // Determine dimension alias overrides
      let [dimensionAliases,] = calculateOverrides(populateObject(dnaData.scaleData, scales, 'dimensionAliases'), getCSSVariableReference);

      // Remove aliases with the same values from scales
      for (let aliasName in dimensionAliases) {
        if (dropTokens[aliasName]) {
          continue;
        }
        for (let scaleName in dnaData.scaleData) {
          let scale = dnaData.scaleData[scaleName];
          delete scale.dimensionAliases[aliasName];
        }
      }

      generateCSSFile([
        dimensionAliases
      ], 'dimensionAliases', 'css/globals/');

      // Scales
      for (let scaleName in dnaData.scaleData) {
        let scale = dnaData.scaleData[scaleName];

        generateFiles([
          scale.dimensionTokens,
          scale.dimensionAliases,
          componentDimensionOverrides[scaleName]
        ], scaleName, 'scales');
      }

      cb();
    }))
    .pipe(gulp.dest('./'))
}

function generateIndex(source, dest) {
  return function generateIndex() {
    let lastFile;
    let componentFilenames = [];
    return gulp.src(source)
      .pipe(through.obj(
        function(file, enc, cb) {
          lastFile = file;
          componentFilenames.push(path.basename(file.path));
          cb(null);
        },
        function(cb) {
          let vinylFile = lastFile.clone({
            contents: false
          });
          vinylFile.path = path.join(lastFile.base, 'index.css');
          vinylFile.contents = Buffer.from(componentFilenames.map(fileName => `@import '${fileName}';`).join('\n'));
          this.push(vinylFile);
          cb();
        }
      ))
      .pipe(gulp.dest(dest));
  }
}

let generateComponentIndex = generateIndex('css/components/*.css', 'css/components/');
let generateGlobalsIndex = generateIndex('css/globals/*.css', 'css/globals/');

exports.updateDNA = gulp.series(
  generateDNAFiles,
  gulp.parallel(
    generateComponentIndex,
    generateGlobalsIndex
  )
);
